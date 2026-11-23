import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '../ide/workspace.js';
import type { Severity } from './detectors.js';

export type EventKind =
  | 'secret' | 'pii' | 'injection' | 'blocked' | 'tool_denied' | 'restricted'
  | 'email_threat' | 'dmarc' | 'hidden_agent' | 'exposure' | 'code_exec' | 'intervention' | 'output_leak';

export interface SecurityEvent {
  id: string;
  at: number;
  kind: EventKind;
  severity: Severity;
  actor: string;
  source: string;
  summary: string;
  action: 'logged' | 'redacted' | 'blocked' | 'quarantined' | 'notified';
  details?: Record<string, unknown>;
}

const DIR = join(DATA_DIR, 'security');
const FILE = join(DIR, 'events.jsonl');
const MAX = 5_000;
const events: SecurityEvent[] = [];
const listeners = new Set<(e: SecurityEvent) => void>();

try {
  if (existsSync(FILE)) {
    const lines = readFileSync(FILE, 'utf8').trim().split('\n').slice(-MAX);
    for (const l of lines) { try { events.push(JSON.parse(l)); } catch { /* skip a torn line */ } }
  }
} catch { /* start empty */ }

export function emit(e: Omit<SecurityEvent, 'id' | 'at'>): SecurityEvent {
  const ev: SecurityEvent = { id: randomUUID(), at: Date.now(), ...e };
  events.push(ev);
  if (events.length > MAX) events.splice(0, events.length - MAX);
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(FILE, JSON.stringify(ev) + '\n');
  } catch (err) {
    console.error('[security] could not persist event', err instanceof Error ? err.message : err);
  }
  for (const fn of listeners) { try { fn(ev); } catch { /* listener errors never block emitters */ } }
  return ev;
}

export function onEvent(fn: (e: SecurityEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function queryEvents(q: { since?: number; kind?: string; actor?: string; minSeverity?: Severity; limit?: number } = {}): SecurityEvent[] {
  const rank: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const min = q.minSeverity ? rank[q.minSeverity] : 0;
  return events
    .filter((e) => (!q.since || e.at >= q.since) && (!q.kind || e.kind === q.kind) && (!q.actor || e.actor === q.actor) && rank[e.severity] >= min)
    .slice(-(q.limit ?? 200))
    .reverse();
}

export function allEvents(): readonly SecurityEvent[] {
  return events;
}
