import { join } from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';
import { ask } from '../llm/index.js';
import { lindyStatus, trigger as triggerLindy } from '../integrations/lindy.js';
import { allEvents, type SecurityEvent } from './events.js';
import { capture } from './governance.js';
import { severityRank, type Severity } from './detectors.js';

// Managed threat response: a review loop correlates new security events into incidents,
// asks a model for triage when one is configured, and notifies through Lindy.

export interface Incident {
  id: string;
  key: string;
  rule: string;
  title: string;
  severity: Severity;
  status: 'open' | 'acknowledged' | 'resolved';
  actor: string;
  openedAt: number;
  updatedAt: number;
  eventIds: string[];
  timeline: { at: number; text: string }[];
  triage?: { model: string; summary: string; at: number } | { error: string; at: number };
  notified?: 'sent' | 'failed' | 'skipped';
}

interface State { incidents: Incident[]; lastReviewAt: number; lastRunAt: number }
const FILE = join(DATA_DIR, 'security', 'incidents.json');
let state: State = { incidents: [], lastReviewAt: 0, lastRunAt: 0, ...readJson<Partial<State>>(FILE, {}) };
const save = () => writeJson(FILE, state);

interface Rule { id: string; title: (e: SecurityEvent[]) => string; match: (e: SecurityEvent) => boolean; threshold: number; windowMs: number; severity: (e: SecurityEvent[]) => Severity }

const maxSev = (evs: SecurityEvent[]): Severity => evs.reduce<Severity>((m, e) => (severityRank(e.severity) > severityRank(m) ? e.severity : m), 'low');

const RULES: Rule[] = [
  { id: 'injection_campaign', title: (e) => `Repeated prompt-injection attempts against ${e[0].actor}`, match: (e) => e.kind === 'injection', threshold: 3, windowMs: 15 * 60_000, severity: () => 'high' },
  { id: 'critical_injection', title: (e) => `Credential-exfiltration instructions reached ${e[0].actor}`, match: (e) => e.kind === 'injection' && e.severity === 'critical', threshold: 1, windowMs: 0, severity: () => 'critical' },
  { id: 'secret_exposure', title: (e) => `Secret left the platform via ${e[0].actor}`, match: (e) => (e.kind === 'secret' && e.action === 'logged') || e.kind === 'output_leak', threshold: 1, windowMs: 0, severity: maxSev },
  { id: 'pii_volume', title: (e) => `High volume of personal data sent by ${e[0].actor}`, match: (e) => e.kind === 'pii' && e.action === 'logged', threshold: 10, windowMs: 60 * 60_000, severity: () => 'medium' },
  { id: 'email_attack', title: (e) => `Malicious email: ${String(e[0].details?.subject ?? e[0].summary).slice(0, 80)}`, match: (e) => e.kind === 'email_threat' && severityRank(e.severity) >= 3, threshold: 1, windowMs: 0, severity: maxSev },
  { id: 'domain_spoofable', title: (e) => `Domain can be spoofed: ${String(e[0].details?.domain ?? '')}`, match: (e) => e.kind === 'dmarc' && severityRank(e.severity) >= 3, threshold: 1, windowMs: 0, severity: maxSev },
  { id: 'hidden_agent', title: (e) => e[0].summary, match: (e) => e.kind === 'hidden_agent', threshold: 1, windowMs: 0, severity: maxSev },
  { id: 'agent_restricted', title: (e) => `${e[0].actor} was restricted`, match: (e) => e.kind === 'intervention' && /restrict/.test(e.summary), threshold: 1, windowMs: 0, severity: () => 'high' },
];

function keyFor(rule: Rule, e: SecurityEvent): string {
  const subject = rule.id === 'email_attack' ? String(e.details?.messageId ?? e.id) : rule.id === 'domain_spoofable' ? String(e.details?.domain ?? '') : rule.id === 'hidden_agent' ? String(e.details?.id ?? e.summary) : e.actor;
  return `${rule.id}:${subject}`;
}

async function triage(inc: Incident, evs: SecurityEvent[]): Promise<void> {
  const prompt = `You are a security analyst. Triage this incident from an AI agent platform in under 150 words: what likely happened, how serious it is, and the 2-4 next steps an admin should take. Do not invent facts beyond the events.\n\nIncident: ${inc.title} (${inc.severity})\nEvents:\n${evs.slice(-15).map((e) => `- ${new Date(e.at).toISOString()} ${e.kind}/${e.severity} actor=${e.actor} source=${e.source}: ${e.summary} (action: ${e.action})`).join('\n')}`;
  try {
    const r = await ask('SECURITY', prompt, { maxTokens: 1_500 });
    inc.triage = { model: r.spec, summary: r.text, at: Date.now() };
    inc.timeline.push({ at: Date.now(), text: `AI triage by ${r.spec}` });
  } catch (err) {
    inc.triage = { error: err instanceof Error ? err.message : String(err), at: Date.now() };
  }
}

async function notify(inc: Incident): Promise<void> {
  if (severityRank(inc.severity) < 3 || !lindyStatus().outbound) { inc.notified = 'skipped'; return; }
  try {
    await triggerLindy({ event: 'security.incident', id: inc.id, title: inc.title, severity: inc.severity, actor: inc.actor, triage: 'summary' in (inc.triage ?? {}) ? (inc.triage as { summary: string }).summary : undefined });
    inc.notified = 'sent';
    inc.timeline.push({ at: Date.now(), text: 'Notified through Lindy' });
  } catch {
    inc.notified = 'failed';
  }
}

let running: Promise<unknown> | null = null;

export async function review(opts: { triage?: boolean } = {}): Promise<{ opened: number; updated: number }> {
  if (running) await running;
  const job = (async () => {
    const now = Date.now();
    const since = state.lastReviewAt;
    const fresh = allEvents().filter((e) => e.at > since);
    let opened = 0, updated = 0;
    const toTriage: [Incident, SecurityEvent[]][] = [];
    for (const rule of RULES) {
      const groups = new Map<string, SecurityEvent[]>();
      for (const e of fresh.filter(rule.match)) groups.set(keyFor(rule, e), [...(groups.get(keyFor(rule, e)) ?? []), e]);
      for (const [key, evs] of groups) {
        const windowEvs = rule.windowMs ? allEvents().filter((e) => rule.match(e) && keyFor(rule, e) === key && e.at >= now - rule.windowMs) : evs;
        if (windowEvs.length < rule.threshold) continue;
        const existing = state.incidents.find((i) => i.key === key && i.status !== 'resolved');
        if (existing) {
          const add = evs.filter((e) => !existing.eventIds.includes(e.id));
          if (!add.length) continue;
          existing.eventIds.push(...add.map((e) => e.id));
          existing.updatedAt = now;
          existing.timeline.push({ at: now, text: `${add.length} more event(s)` });
          const sev = rule.severity(windowEvs);
          if (severityRank(sev) > severityRank(existing.severity)) { existing.severity = sev; existing.timeline.push({ at: now, text: `Escalated to ${sev}` }); }
          updated++;
        } else {
          const inc: Incident = {
            id: `inc_${randomUUID().slice(0, 8)}`, key, rule: rule.id, title: rule.title(windowEvs), severity: rule.severity(windowEvs),
            status: 'open', actor: windowEvs[0].actor, openedAt: now, updatedAt: now, eventIds: windowEvs.map((e) => e.id),
            timeline: [{ at: now, text: `Opened by rule ${rule.id} from ${windowEvs.length} event(s)` }],
          };
          state.incidents.unshift(inc);
          capture('incident', 'threat-response', inc.title, `${inc.severity} · ${inc.rule}`, { id: inc.id });
          if (opts.triage !== false) toTriage.push([inc, windowEvs]);
          opened++;
        }
      }
    }
    for (const [inc, evs] of toTriage) { await triage(inc, evs); await notify(inc); }
    state.lastReviewAt = now;
    state.lastRunAt = now;
    state.incidents = state.incidents.slice(0, 500);
    save();
    return { opened, updated };
  })();
  running = job;
  try { return await job; } finally { running = null; }
}

export function incidents() {
  return { lastRunAt: state.lastRunAt, incidents: state.incidents };
}

export function eventsFor(id: string): SecurityEvent[] {
  const inc = state.incidents.find((i) => i.id === id);
  if (!inc) throw new Error('Incident not found');
  const ids = new Set(inc.eventIds);
  return allEvents().filter((e) => ids.has(e.id));
}

export function setStatus(id: string, status: Incident['status'], note?: string): Incident {
  const inc = state.incidents.find((i) => i.id === id);
  if (!inc) throw new Error('Incident not found');
  if (!['open', 'acknowledged', 'resolved'].includes(status)) throw new Error('status must be open, acknowledged or resolved');
  inc.status = status;
  inc.updatedAt = Date.now();
  inc.timeline.push({ at: inc.updatedAt, text: `Marked ${status}${note ? `: ${note}` : ''}` });
  capture('incident', 'threat-response', `${inc.title} → ${status}`, note ?? '', { id: inc.id });
  save();
  return inc;
}

export async function retriage(id: string): Promise<Incident> {
  const inc = state.incidents.find((i) => i.id === id);
  if (!inc) throw new Error('Incident not found');
  await triage(inc, eventsFor(id));
  save();
  return inc;
}

let timer: NodeJS.Timeout | undefined;
export function startThreatResponse(intervalMs = Number(process.env.NL_THREAT_INTERVAL_MS ?? 5 * 60_000)): void {
  if (timer) return;
  timer = setInterval(() => { review().catch((err) => console.error('[threat]', err instanceof Error ? err.message : err)); }, intervalMs);
  timer.unref();
}
