import { promises as dnsp } from 'dns';

export interface TxtResolver { resolveTxt(name: string): Promise<string[][]>; resolveMx(name: string): Promise<{ exchange: string; priority: number }[]> }

function resolver(): TxtResolver {
  const servers = (process.env.NL_DNS_SERVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!servers.length) return dnsp;
  const r = new dnsp.Resolver();
  r.setServers(servers);
  return r;
}

async function txt(r: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await r.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw new Error(`DNS lookup for ${name} failed (${code ?? 'error'})`);
  }
}

export interface Check { id: string; status: 'pass' | 'warn' | 'fail'; title: string; detail: string }

export interface DomainReport {
  domain: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  dmarc: { record: string | null; tags: Record<string, string> };
  spf: { record: string | null; lookups: number; all: string | null };
  dkim: { selectorsFound: string[]; checked: string[] };
  mx: string[];
  checks: Check[];
  recommendedDmarc: string;
}

const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 'k2', 's1', 's2', 'mail', 'dkim', 'smtp', 'mandrill', 'mxvault', 'zoho', 'protonmail'];

function tags(record: string): Record<string, string> {
  return Object.fromEntries(record.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
  }));
}

export async function checkDomain(domainInput: string, r: TxtResolver = resolver()): Promise<DomainReport> {
  const domain = domainInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error('Enter a domain like example.com.');
  const checks: Check[] = [];
  const add = (id: string, status: Check['status'], title: string, detail: string) => checks.push({ id, status, title, detail });

  const [dmarcTxt, rootTxt, mx] = await Promise.all([
    txt(r, `_dmarc.${domain}`),
    txt(r, domain),
    r.resolveMx(domain).then((x) => x.sort((a, b) => a.priority - b.priority).map((m) => m.exchange)).catch(() => [] as string[]),
  ]);

  const dmarcRecords = dmarcTxt.filter((t) => /^v=DMARC1/i.test(t));
  const dmarcRecord = dmarcRecords[0] ?? null;
  const t = dmarcRecord ? tags(dmarcRecord) : {};
  if (!dmarcRecord) add('dmarc_missing', 'fail', 'No DMARC record', `Anyone can send mail as ${domain} and receivers have no policy to reject it.`);
  else {
    if (dmarcRecords.length > 1) add('dmarc_multiple', 'fail', 'Multiple DMARC records', 'Receivers ignore DMARC when more than one record exists.');
    const p = (t.p ?? '').toLowerCase();
    if (p === 'reject') add('dmarc_policy', 'pass', 'Policy: reject', 'Spoofed mail is rejected.');
    else if (p === 'quarantine') add('dmarc_policy', 'warn', 'Policy: quarantine', 'Spoofed mail goes to spam. Move to p=reject once reports are clean.');
    else add('dmarc_policy', 'fail', `Policy: ${p || 'missing'}`, 'p=none only monitors; spoofed mail is still delivered.');
    const pct = Number(t.pct ?? 100);
    if (pct < 100) add('dmarc_pct', 'warn', `Policy applies to ${pct}% of mail`, 'Raise pct to 100 to enforce on all mail.');
    if (!t.rua) add('dmarc_rua', 'warn', 'No aggregate report address', 'Add rua=mailto:... to receive DMARC reports and see who sends as your domain.');
    else add('dmarc_rua', 'pass', 'Aggregate reports enabled', t.rua);
    if (t.sp && t.sp.toLowerCase() === 'none' && p !== 'none') add('dmarc_sp', 'warn', 'Subdomains are not protected', 'sp=none lets attackers spoof subdomains.');
  }

  const spfRecords = rootTxt.filter((x) => /^v=spf1\b/i.test(x));
  const spf = spfRecords[0] ?? null;
  let lookups = 0;
  let all: string | null = null;
  if (!spf) add('spf_missing', 'fail', 'No SPF record', 'Receivers cannot tell which servers may send for this domain.');
  else {
    if (spfRecords.length > 1) add('spf_multiple', 'fail', 'Multiple SPF records', 'SPF permerrors when more than one record exists.');
    const terms = spf.split(/\s+/).slice(1);
    lookups = terms.filter((x) => /^[+~?-]?(include:|a\b|a:|mx\b|mx:|ptr|exists:|redirect=)/i.test(x)).length;
    all = terms.find((x) => /^[+~?-]?all$/i.test(x)) ?? null;
    if (lookups > 10) add('spf_lookups', 'fail', `SPF needs ${lookups} DNS lookups`, 'Over the limit of 10, so SPF permerrors. Flatten includes.');
    else add('spf_lookups', lookups > 8 ? 'warn' : 'pass', `SPF uses ${lookups} of 10 DNS lookups`, lookups > 8 ? 'Close to the limit; includes can grow.' : 'Within the limit (top level only; nested includes also count).');
    if (!all) add('spf_all', 'warn', 'SPF has no all mechanism', 'End the record with -all or ~all.');
    else if (/^\+?all$/i.test(all)) add('spf_all', 'fail', 'SPF allows everyone (+all)', 'Any server can pass SPF for this domain. Use -all.');
    else if (/^\?all$/i.test(all)) add('spf_all', 'warn', 'SPF is neutral (?all)', 'Use ~all or -all.');
    else add('spf_all', 'pass', `SPF ends with ${all}`, all.startsWith('-') ? 'Unauthorized servers fail.' : 'Unauthorized servers soft-fail; DMARC enforcement does the rest.');
    if (/\bptr\b/i.test(spf)) add('spf_ptr', 'warn', 'SPF uses ptr', 'ptr is deprecated and slow.');
  }

  const found: string[] = [];
  await Promise.all(DKIM_SELECTORS.map(async (s) => {
    const recs = await txt(r, `${s}._domainkey.${domain}`).catch(() => []);
    if (recs.some((x) => /v=DKIM1|k=rsa|k=ed25519|p=/i.test(x))) found.push(s);
  }));
  if (found.length) add('dkim', 'pass', `DKIM found (${found.join(', ')})`, 'At least one common selector publishes a key.');
  else add('dkim', 'warn', 'No DKIM key on common selectors', 'Your provider may use a custom selector; check a received message\'s DKIM-Signature s= tag.');
  if (!mx.length) add('mx', 'warn', 'No MX records', dmarcRecord && (t.p ?? '').toLowerCase() === 'reject' ? 'Fine for a domain that never receives mail.' : 'If this domain never sends mail, publish v=spf1 -all and p=reject.');

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const grade = !dmarcRecord || /^\+?all$/i.test(all ?? '') ? 'F' : fails >= 2 ? 'D' : fails === 1 ? 'C' : warns >= 2 ? 'B' : 'A';
  const rua = t.rua ?? `mailto:dmarc-reports@${domain}`;
  const next = (t.p ?? 'none').toLowerCase() === 'none' ? 'quarantine' : 'reject';
  return {
    domain, grade,
    dmarc: { record: dmarcRecord, tags: t },
    spf: { record: spf, lookups, all },
    dkim: { selectorsFound: found.sort(), checked: DKIM_SELECTORS },
    mx,
    checks,
    recommendedDmarc: `v=DMARC1; p=${dmarcRecord ? next : 'none'}; rua=${rua}; adkim=s; aspf=s; pct=100`,
  };
}

export interface AggregateSummary {
  orgName: string | null;
  domain: string | null;
  range: { begin: number | null; end: number | null };
  policy: string | null;
  totalMessages: number;
  passRate: number;
  sources: { ip: string; count: number; spf: string; dkim: string; disposition: string; headerFrom: string; aligned: boolean }[];
  failingSources: number;
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i'));
  return m ? m[1] : null;
}

export function parseAggregateReport(xml: string): AggregateSummary {
  if (!/<feedback[\s>]/i.test(xml)) throw new Error('This does not look like a DMARC aggregate report (expected a <feedback> XML document).');
  const sources: AggregateSummary['sources'] = [];
  for (const m of xml.matchAll(/<record>([\s\S]*?)<\/record>/gi)) {
    const rec = m[1];
    const pe = rec.match(/<policy_evaluated>([\s\S]*?)<\/policy_evaluated>/i)?.[1] ?? '';
    const spf = (tag(pe, 'spf') ?? 'none').toLowerCase();
    const dkim = (tag(pe, 'dkim') ?? 'none').toLowerCase();
    sources.push({
      ip: tag(rec, 'source_ip') ?? '?', count: Number(tag(rec, 'count') ?? 0),
      spf, dkim, disposition: (tag(pe, 'disposition') ?? 'none').toLowerCase(), headerFrom: tag(rec, 'header_from') ?? '',
      aligned: spf === 'pass' || dkim === 'pass',
    });
  }
  const total = sources.reduce((t, s) => t + s.count, 0);
  const passing = sources.filter((s) => s.aligned).reduce((t, s) => t + s.count, 0);
  const meta = xml.match(/<report_metadata>([\s\S]*?)<\/report_metadata>/i)?.[1] ?? '';
  const pol = xml.match(/<policy_published>([\s\S]*?)<\/policy_published>/i)?.[1] ?? '';
  return {
    orgName: tag(meta, 'org_name'),
    domain: tag(pol, 'domain'),
    range: { begin: Number(tag(meta, 'begin')) * 1000 || null, end: Number(tag(meta, 'end')) * 1000 || null },
    policy: tag(pol, 'p'),
    totalMessages: total,
    passRate: total ? Math.round((passing / total) * 1000) / 10 : 0,
    sources: sources.sort((a, b) => Number(a.aligned) - Number(b.aligned) || b.count - a.count),
    failingSources: sources.filter((s) => !s.aligned).length,
  };
}
