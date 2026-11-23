import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';

// Append-only, hash-chained communications archive: each record stores the previous
// record's hash, so editing or deleting a record breaks verification from that point on.

export type RecordKind = 'llm_call' | 'agent_run' | 'lindy_out' | 'lindy_in' | 'email' | 'incident' | 'assistant' | 'purge' | 'note';

export interface ArchiveRecord {
  id: string;
  seq: number;
  at: number;
  kind: RecordKind;
  actor: string;
  subject: string;
  content: string;
  meta?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Hold { id: string; name: string; terms: string[]; createdAt: number; active: boolean }
interface GovSettings { retentionDays: number; holds: Hold[]; capture: Record<RecordKind, boolean> }

const DIR = join(DATA_DIR, 'governance');
const FILE = join(DIR, 'archive.jsonl');
const SETTINGS = join(DIR, 'settings.json');
const GENESIS = '0'.repeat(64);

let records: ArchiveRecord[] = [];
let settings: GovSettings = readJson<GovSettings>(SETTINGS, {
  retentionDays: Number(process.env.NL_RETENTION_DAYS ?? 365),
  holds: [],
  capture: { llm_call: true, agent_run: true, lindy_out: true, lindy_in: true, email: true, incident: true, assistant: true, purge: true, note: true },
});

try {
  if (existsSync(FILE)) records = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch { records = []; }

function hashOf(r: Omit<ArchiveRecord, 'hash'>): string {
  const { id, seq, at, kind, actor, subject, content, meta, prevHash } = r;
  return createHash('sha256').update(JSON.stringify({ id, seq, at, kind, actor, subject, content, meta: meta ?? null, prevHash })).digest('hex');
}

export function capture(kind: RecordKind, actor: string, subject: string, content: string, meta?: Record<string, unknown>): ArchiveRecord | null {
  if (settings.capture[kind] === false) return null;
  const last = records[records.length - 1];
  const base = {
    id: randomUUID(), seq: (last?.seq ?? 0) + 1, at: Date.now(), kind, actor,
    subject: subject.slice(0, 300), content: content.slice(0, 20_000), meta, prevHash: last?.hash ?? GENESIS,
  };
  const rec: ArchiveRecord = { ...base, hash: hashOf(base) };
  records.push(rec);
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(FILE, JSON.stringify(rec) + '\n');
  } catch (err) {
    console.error('[governance] could not persist record', err instanceof Error ? err.message : err);
  }
  return rec;
}

export function verifyChain(): { ok: boolean; records: number; brokenAt?: number; reason?: string } {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const { hash, ...rest } = r;
    if (hashOf(rest) !== hash) return { ok: false, records: records.length, brokenAt: r.seq, reason: 'record contents do not match their hash' };
    if (i > 0 && r.prevHash !== records[i - 1].hash) return { ok: false, records: records.length, brokenAt: r.seq, reason: 'record does not link to the previous one' };
  }
  return { ok: true, records: records.length };
}

function onHold(r: ArchiveRecord): string | null {
  const hay = `${r.subject}\n${r.content}\n${r.actor}`.toLowerCase();
  const h = settings.holds.find((x) => x.active && x.terms.some((t) => hay.includes(t.toLowerCase())));
  return h ? h.name : null;
}

export function search(q: { text?: string; kind?: string; actor?: string; since?: number; until?: number; limit?: number }) {
  const terms = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = records.filter((r) =>
    (!q.kind || r.kind === q.kind) && (!q.actor || r.actor === q.actor) && (!q.since || r.at >= q.since) && (!q.until || r.at <= q.until) &&
    terms.every((t) => `${r.subject}\n${r.content}\n${r.actor}`.toLowerCase().includes(t)));
  return { total: hits.length, results: hits.slice(-(q.limit ?? 100)).reverse().map((r) => ({ ...r, hold: onHold(r) })) };
}

// Purging rewrites the file without expired records; the first kept record's prevHash
// becomes the new anchor, and a purge record documents what was removed.
export function applyRetention(now = Date.now()): { removed: number; keptOnHold: number } {
  const cutoff = now - settings.retentionDays * 86_400_000;
  let removed = 0, keptOnHold = 0;
  const kept = records.filter((r) => {
    if (r.at >= cutoff || r.kind === 'purge') return true;
    if (onHold(r)) { keptOnHold++; return true; }
    removed++;
    return false;
  });
  if (!removed) return { removed, keptOnHold };
  records = kept;
  const tmp = FILE + '.tmp';
  mkdirSync(DIR, { recursive: true });
  writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  renameSync(tmp, FILE);
  capture('purge', 'governance', `Retention removed ${removed} record(s) older than ${settings.retentionDays} days`, '', { removed, keptOnHold, cutoff });
  return { removed, keptOnHold };
}

export function governanceStatus() {
  const first = records[0];
  return {
    records: records.length,
    oldest: first?.at ?? null,
    newest: records[records.length - 1]?.at ?? null,
    retentionDays: settings.retentionDays,
    holds: settings.holds,
    capture: settings.capture,
    chain: verifyChain(),
    byKind: records.reduce<Record<string, number>>((m, r) => { m[r.kind] = (m[r.kind] ?? 0) + 1; return m; }, {}),
  };
}

export function updateGovernance(patch: { retentionDays?: number; capture?: Partial<Record<RecordKind, boolean>> }) {
  if (patch.retentionDays !== undefined) {
    const d = Number(patch.retentionDays);
    if (!Number.isFinite(d) || d < 1 || d > 3650) throw new Error('Retention must be between 1 and 3650 days.');
    settings.retentionDays = Math.round(d);
  }
  if (patch.capture) settings.capture = { ...settings.capture, ...patch.capture };
  writeJson(SETTINGS, settings);
  return governanceStatus();
}

export function addHold(name: string, terms: string[]): Hold {
  const clean = terms.map((t) => t.trim()).filter(Boolean);
  if (!name.trim() || !clean.length) throw new Error('A legal hold needs a name and at least one search term.');
  const h: Hold = { id: randomUUID(), name: name.trim(), terms: clean, createdAt: Date.now(), active: true };
  settings.holds.push(h);
  writeJson(SETTINGS, settings);
  capture('note', 'governance', `Legal hold "${h.name}" placed`, `Terms: ${clean.join(', ')}`);
  return h;
}

export function releaseHold(id: string): void {
  const h = settings.holds.find((x) => x.id === id);
  if (!h) throw new Error('Hold not found');
  h.active = false;
  writeJson(SETTINGS, settings);
  capture('note', 'governance', `Legal hold "${h.name}" released`, '');
}

export function exportRecords(q: Parameters<typeof search>[0]): string {
  return search({ ...q, limit: 100_000 }).results.map((r) => JSON.stringify(r)).join('\n');
}
