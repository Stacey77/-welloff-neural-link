import { envValue } from '../llm/catalog.js';
import { scan } from './detectors.js';

export interface EmailSignal { id: string; severity: 'low' | 'medium' | 'high' | 'critical'; title: string; detail: string }

export interface EmailReport {
  verdict: 'clean' | 'suspicious' | 'malicious';
  score: number;
  from: { name: string; address: string; domain: string };
  replyTo: string | null;
  subject: string;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  links: { href: string; text: string; host: string }[];
  attachments: string[];
  signals: EmailSignal[];
}

const POINTS = { low: 5, medium: 15, high: 30, critical: 50 } as const;
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at']);
const RISKY_EXT = /\.(exe|scr|js|jse|vbs|vbe|wsf|hta|bat|cmd|ps1|msi|iso|img|lnk|html?|svg|docm|xlsm|pptm|jar|one)$/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|gz|tar|cab)$/i;
const LURES: [RegExp, string][] = [
  [/verify (?:your )?(?:account|identity|password)/i, 'asks you to verify an account'],
  [/(?:password|credentials?) (?:will )?expire/i, 'claims a password is expiring'],
  [/\b(?:wire|bank) transfer\b|\bupdated? (?:bank|payment) details\b|\bnew account number\b/i, 'asks about payment or bank details'],
  [/\bgift ?cards?\b/i, 'mentions gift cards'],
  [/\burgent(?:ly)?\b|\bimmediately\b|\bwithin 24 hours\b|\baction required\b/i, 'uses urgency'],
  [/\b(?:invoice|payment) (?:is )?(?:overdue|past due|attached)\b/i, 'invoice or payment pressure'],
  [/\bsign[- ]?in\b.*\bsuspend|\baccount (?:has been |will be )?(?:locked|suspended|disabled)\b/i, 'threatens account suspension'],
  [/\bkeep this (?:confidential|between us)\b|\bdon'?t tell\b/i, 'asks for secrecy'],
];

function protectedDomains(): string[] {
  return (envValue('NL_PROTECTED_DOMAINS') ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

function unfoldHeaders(raw: string): { headers: Map<string, string[]>; body: string } {
  const norm = raw.replace(/\r\n/g, '\n');
  const split = norm.indexOf('\n\n');
  const head = split >= 0 ? norm.slice(0, split) : norm;
  const body = split >= 0 ? norm.slice(split + 2) : '';
  const headers = new Map<string, string[]>();
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    headers.set(k, [...(headers.get(k) ?? []), line.slice(i + 1).trim()]);
  }
  return { headers, body };
}

function parseAddress(v: string): { name: string; address: string; domain: string } {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const address = (m ? m[2] : v).trim().toLowerCase();
  const name = m ? m[1].trim() : '';
  return { name, address, domain: address.split('@')[1] ?? '' };
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

function skeleton(d: string): string {
  return d.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/5/g, 's').replace(/[-_]/g, '');
}

function registrable(host: string): string {
  const parts = host.toLowerCase().split('.');
  return parts.slice(-2).join('.');
}

export function lookalike(domain: string, protectedList = protectedDomains()): string | null {
  const d = registrable(domain);
  for (const p of protectedList) {
    const pr = registrable(p);
    if (d === pr) continue;
    const dn = d.split('.')[0], pn = pr.split('.')[0];
    if (skeleton(dn) === skeleton(pn) || (pn.length >= 5 && lev(dn, pn) <= 2) || (pn.length >= 4 && dn.includes(pn) && dn !== pn)) return p;
  }
  return null;
}

function decodeBody(body: string): string {
  let text = body;
  if (/content-transfer-encoding:\s*quoted-printable/i.test(body) || /=\r?\n/.test(body)) {
    text = text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  return text;
}

function extractLinks(html: string): { href: string; text: string; host: string }[] {
  const links: { href: string; text: string; host: string }[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = m[1].trim();
    let host = '';
    try { host = new URL(href).hostname.toLowerCase(); } catch { continue; }
    links.push({ href, text: m[2].replace(/<[^>]+>/g, '').trim().slice(0, 200), host });
  }
  for (const m of html.replace(/<a\b[\s\S]*?<\/a>/gi, ' ').matchAll(/\bhttps?:\/\/[^\s"'<>)]+/gi)) {
    try { links.push({ href: m[0], text: '', host: new URL(m[0]).hostname.toLowerCase() }); } catch { /* not a URL */ }
  }
  return links.slice(0, 200);
}

function authValue(results: string, mech: string): string | null {
  const m = results.match(new RegExp(`\\b${mech}=([a-z]+)`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

export function analyzeEmail(raw: string): EmailReport {
  if (!raw || raw.length < 10) throw new Error('Paste the full email source, including headers.');
  if (raw.length > 2_000_000) throw new Error('Email is larger than 2 MB.');
  const { headers, body } = unfoldHeaders(raw);
  const h = (k: string) => headers.get(k)?.[0] ?? '';
  const from = parseAddress(h('from'));
  const replyTo = h('reply-to') ? parseAddress(h('reply-to')).address : null;
  const returnPath = h('return-path') ? parseAddress(h('return-path')).address : null;
  const subject = h('subject');
  const authRes = (headers.get('authentication-results') ?? []).join(' ; ');
  const auth = { spf: authValue(authRes, 'spf'), dkim: authValue(authRes, 'dkim'), dmarc: authValue(authRes, 'dmarc') };
  const text = decodeBody(body);
  const links = extractLinks(text);
  const attachments = [...text.matchAll(/(?:filename|name)\*?=\s*"?([^";\r\n]+)"?/gi)].map((m) => m[1].trim()).filter((v, i, a) => a.indexOf(v) === i);
  const signals: EmailSignal[] = [];
  const add = (id: string, severity: EmailSignal['severity'], title: string, detail: string) => signals.push({ id, severity, title, detail });

  if (!from.address.includes('@')) add('no_from', 'medium', 'Missing or malformed From address', h('from') || '(none)');
  if (auth.dmarc === 'fail') add('dmarc_fail', 'high', 'DMARC failed', `The message failed ${from.domain}'s DMARC policy, so it may not be from that domain.`);
  if (auth.spf && ['fail', 'softfail'].includes(auth.spf)) add('spf_fail', auth.spf === 'fail' ? 'high' : 'medium', `SPF ${auth.spf}`, 'The sending server is not authorized to send for this domain.');
  if (auth.dkim && ['fail', 'none', 'permerror'].includes(auth.dkim)) add('dkim_fail', auth.dkim === 'fail' ? 'high' : 'low', `DKIM ${auth.dkim}`, 'The message signature is missing or invalid.');
  if (!authRes) add('no_auth', 'low', 'No authentication results', 'The receiving server added no Authentication-Results header, so SPF, DKIM and DMARC could not be checked.');
  if (replyTo && from.domain && replyTo.split('@')[1] !== from.domain) add('reply_to_mismatch', 'medium', 'Replies go to a different domain', `From ${from.domain}, but replies go to ${replyTo}.`);
  if (returnPath && from.domain && returnPath.split('@')[1] && registrable(returnPath.split('@')[1]) !== registrable(from.domain)) add('return_path_mismatch', 'low', 'Envelope sender differs', `Return-Path is ${returnPath}.`);
  const nameEmail = from.name.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase();
  if (nameEmail && nameEmail !== from.address) add('display_name_spoof', 'high', 'Display name shows a different address', `The name says ${nameEmail} but the real sender is ${from.address}.`);
  const look = from.domain ? lookalike(from.domain) : null;
  if (look) add('lookalike_domain', 'critical', 'Lookalike of a protected domain', `${from.domain} imitates ${look}.`);
  for (const p of protectedDomains()) {
    const brand = registrable(p).split('.')[0];
    if (brand.length >= 4 && from.name.toLowerCase().includes(brand) && registrable(from.domain) !== registrable(p)) {
      add('brand_impersonation', 'high', 'Display name uses your brand', `"${from.name}" is sent from ${from.domain}, not ${p}.`);
    }
  }

  for (const l of links) {
    const shown = l.text.match(/https?:\/\/[^\s/]+|(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?/i)?.[0];
    if (shown) {
      let shownHost = shown.toLowerCase().replace(/^https?:\/\//, '');
      shownHost = shownHost.replace(/^www\./, '');
      if (shownHost.includes('.') && registrable(shownHost) !== registrable(l.host)) add('link_mismatch', 'high', 'Link text and destination differ', `Shows ${shownHost} but opens ${l.host}.`);
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(l.host)) add('ip_link', 'medium', 'Link to a raw IP address', l.href.slice(0, 120));
    if (l.host.startsWith('xn--') || l.host.includes('.xn--')) add('punycode_link', 'medium', 'Internationalized (punycode) link', l.host);
    if (SHORTENERS.has(l.host)) add('shortener', 'low', 'Shortened link hides the destination', l.href);
    const lk = lookalike(l.host);
    if (lk) add('lookalike_link', 'critical', 'Link to a lookalike domain', `${l.host} imitates ${lk}.`);
    if (l.href.startsWith('http://') && /login|sign.?in|verify|account|password/i.test(l.href)) add('insecure_login_link', 'medium', 'Login link without HTTPS', l.href.slice(0, 120));
  }
  for (const a of attachments) {
    if (RISKY_EXT.test(a)) add('risky_attachment', 'high', 'Risky attachment type', a);
    else if (ARCHIVE_EXT.test(a)) add('archive_attachment', 'low', 'Archive attachment', a);
    if (/\.(pdf|docx?|xlsx?)\.(exe|js|scr|html?)$/i.test(a)) add('double_extension', 'critical', 'Disguised file extension', a);
  }
  const plain = text.replace(/<[^>]+>/g, ' ');
  const lures = LURES.filter(([re]) => re.test(`${subject}\n${plain}`)).map(([, label]) => label);
  if (lures.length) add('lure_language', lures.length >= 3 ? 'high' : lures.length === 2 ? 'medium' : 'low', 'Phishing language', lures.join('; '));
  const secrets = scan(plain, ['secret']);
  if (secrets.length) add('contains_secret', 'medium', 'Contains credentials', `${secrets.length} secret-looking value(s) in the body.`);

  const dedup = signals.filter((s, i) => signals.findIndex((x) => x.id === s.id && x.detail === s.detail) === i);
  const score = Math.min(100, dedup.reduce((t, s) => t + POINTS[s.severity], 0));
  const verdict = dedup.some((s) => s.severity === 'critical') || score >= 60 ? 'malicious' : score >= 25 ? 'suspicious' : 'clean';
  return { verdict, score, from, replyTo, subject, auth, links: links.slice(0, 50), attachments, signals: dedup };
}
