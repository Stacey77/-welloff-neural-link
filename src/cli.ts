#!/usr/bin/env node
import { readFileSync } from 'fs';

const BASE = (process.env.NL_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const KEY = process.env.NEURAL_API_KEY;
const tty = process.stdout.isTTY;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(KEY ? { 'x-api-key': KEY } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Cannot reach neural-link at ${BASE}. Start it with npm run dev, or set NL_URL.`);
  }
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(typeof data === 'object' && data?.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : `HTTP ${res.status}`);
  return data;
}

function print(data: unknown, human?: () => string): void {
  if (!tty || !human) { console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2)); return; }
  console.log(human());
}

const HELP = `nl — neural-link from the command line

  nl agents                               list agents
  nl dispatch <AGENT> <command> [json]    run one agent command
  nl ask "<prompt>"                        MAESTRO routes to the best model
  nl tools "<query>"                       search MCP tools
  nl skills [name]                         list skills or print one
  nl security status|events|incidents|inventory
  nl email <file.eml|->                    analyze an email
  nl dmarc <domain>                        check DMARC, SPF and DKIM
  nl archive "<query>"                     search the governance archive

Env: NL_URL (default http://localhost:3001), NEURAL_API_KEY`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const S = '/ide/api/security';
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help':
      console.log(HELP); return;
    case 'agents': {
      const d = await call('GET', '/health');
      return print(d.agents, () => d.agents.join('\n'));
    }
    case 'dispatch': {
      const [agentId, command, json] = rest;
      if (!agentId || !command) throw new Error('usage: nl dispatch <AGENT> <command> [json]');
      const d = await call('POST', '/dispatch', { agentId: agentId.toUpperCase(), command, params: json ? JSON.parse(json) : {} });
      return print(d);
    }
    case 'ask': {
      if (!rest.length) throw new Error('usage: nl ask "<prompt>"');
      const d = await call('POST', '/dispatch', { agentId: 'MAESTRO', command: 'ask', params: { prompt: rest.join(' ') } });
      return print(d.result, () => `${d.result.model}\n\n${d.result.answer}`);
    }
    case 'tools': {
      const d = await call('GET', `${S}/tools/search?q=${encodeURIComponent(rest.join(' '))}`);
      return print(d, () => d.map((t: any) => `${t.name}\n  ${t.description}`).join('\n'));
    }
    case 'skills': {
      if (rest[0]) { const d = await call('GET', `${S}/skills/${encodeURIComponent(rest[0])}`); return print(d.content, () => d.content); }
      const d = await call('GET', `${S}/tools`);
      return print(d.skills, () => d.skills.map((s: any) => `${s.name}\n  ${s.description}`).join('\n'));
    }
    case 'security': {
      const sub = rest[0] ?? 'status';
      if (sub === 'status') {
        const d = await call('GET', `${S}/overview`);
        return print(d, () => [`Posture ${d.posture}/100 · ${d.openIncidents} open incident(s) · ${d.events24h} events in 24h (${d.redacted24h} redacted, ${d.blocked24h} blocked)`, ...d.topFindings.map((f: any) => `[${f.severity}] ${f.title}\n   ${f.fix}`)].join('\n'));
      }
      if (sub === 'events') { const d = await call('GET', `${S}/events?limit=30`); return print(d, () => d.map((e: any) => `${new Date(e.at).toISOString()} ${e.severity.padEnd(8)} ${e.kind.padEnd(13)} ${e.actor}: ${e.summary}`).join('\n')); }
      if (sub === 'incidents') { const d = await call('GET', `${S}/incidents`); return print(d.incidents, () => d.incidents.map((i: any) => `${i.id} ${i.status.padEnd(12)} ${i.severity.padEnd(8)} ${i.title}`).join('\n') || 'No incidents.'); }
      if (sub === 'inventory') { const d = await call('GET', `${S}/inventory`); return print(d); }
      throw new Error('usage: nl security status|events|incidents|inventory');
    }
    case 'email': {
      const file = rest[0];
      if (!file) throw new Error('usage: nl email <file.eml|->');
      const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
      const d = await call('POST', `${S}/email`, { raw });
      return print(d, () => [`${d.verdict.toUpperCase()} (score ${d.score}) · ${d.from.address} · ${d.subject}`, ...d.signals.map((s: any) => `[${s.severity}] ${s.title}: ${s.detail}`)].join('\n'));
    }
    case 'dmarc': {
      if (!rest[0]) throw new Error('usage: nl dmarc <domain>');
      const d = await call('POST', `${S}/dmarc/check`, { domain: rest[0] });
      return print(d, () => [`${d.domain}: grade ${d.grade}`, ...d.checks.map((c: any) => `${c.status.padEnd(4)} ${c.title}`), `Suggested DMARC: ${d.recommendedDmarc}`].join('\n'));
    }
    case 'archive': {
      const d = await call('GET', `${S}/governance/search?q=${encodeURIComponent(rest.join(' '))}&limit=20`);
      return print(d, () => `${d.total} record(s)\n` + d.results.map((r: any) => `#${r.seq} ${new Date(r.at).toISOString()} ${r.kind} ${r.actor}: ${r.subject}`).join('\n'));
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run nl help.`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`nl: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
