import { join } from 'path';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';
import { a2aBus } from '../a2a/bus.js';
import { onIncident } from '../security/threat.js';
import { subscribe as onNotification } from '../assistant/notify.js';
import { telemetry, getProject } from '../engineering/index.js';
import { createJob } from './jobs.js';

// Events that start jobs on their own. autoRun=false creates the job and waits for a click.

export interface TriggerDef { id: string; label: string; description: string }
export const TRIGGERS: TriggerDef[] = [
  { id: 'security-incident', label: 'Security incident (high or critical)', description: 'Threat response opened a serious incident' },
  { id: 'engineering-alert', label: 'Engineering telemetry failure', description: 'SENTINEL raised a fail-level alert on live sensor data' },
  { id: 'prospect-reply', label: 'Prospect replied', description: 'EVE matched an inbound reply to a prospect' },
  { id: 'booking', label: 'New booking', description: 'EVE received a booking' },
  { id: 'deadline', label: 'Deadline due tomorrow', description: 'EVE flagged a deadline due within a day' },
  { id: 'lead-scan', label: 'Scheduled lead scan', description: 'ARIA\'s hourly scan found leads' },
  { id: 'fleet-health', label: 'Scheduled fleet check', description: 'FORGE\'s 15-minute fleet check reported' },
  { id: 'cve-scan', label: 'Scheduled CVE scan', description: 'MESH\'s daily vulnerability scan reported' },
  { id: 'cost-scan', label: 'Scheduled cost scan', description: 'INFRA\'s cost scan reported' },
];

interface TriggerSetting { enabled: boolean; autoRun: boolean }
const DEFAULTS: Record<string, TriggerSetting> = {
  'security-incident': { enabled: true, autoRun: true },
  'engineering-alert': { enabled: true, autoRun: true },
  'prospect-reply': { enabled: true, autoRun: true },
  booking: { enabled: true, autoRun: true },
  deadline: { enabled: true, autoRun: true },
  'lead-scan': { enabled: true, autoRun: false },
  'fleet-health': { enabled: false, autoRun: false },
  'cve-scan': { enabled: true, autoRun: false },
  'cost-scan': { enabled: true, autoRun: false },
};
const FILE = join(DATA_DIR, 'orchestrator', 'triggers.json');
let saved = readJson<Record<string, Partial<TriggerSetting>>>(FILE, {});
const recent = new Map<string, number>();
const fired: number[] = [];
const MAX_PER_HOUR = Number(process.env.NL_MAX_AUTO_JOBS_PER_HOUR ?? 20);
const DEDUPE_MS = 30 * 60_000;

export function triggerSettings() {
  return TRIGGERS.map((t) => ({ ...t, ...DEFAULTS[t.id], ...saved[t.id] }));
}

export function updateTrigger(id: string, patch: Partial<TriggerSetting>) {
  if (!TRIGGERS.some((t) => t.id === id)) throw new Error('Unknown trigger');
  saved = { ...saved, [id]: { ...saved[id], ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}), ...(patch.autoRun !== undefined ? { autoRun: Boolean(patch.autoRun) } : {}) } };
  writeJson(FILE, saved);
  return triggerSettings().find((t) => t.id === id);
}

function fire(trigger: string, ref: string, title: string, input: string): void {
  const s = triggerSettings().find((t) => t.id === trigger);
  if (!s?.enabled) return;
  const key = `${trigger}:${ref}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - DEDUPE_MS) return;
  while (fired.length && fired[0] < now - 3_600_000) fired.shift();
  if (fired.length >= MAX_PER_HOUR) { console.warn(`[jobs] auto-job limit reached (${MAX_PER_HOUR}/hour); skipped ${trigger}`); return; }
  recent.set(key, now);
  fired.push(now);
  try {
    createJob(input, { title, source: { type: 'trigger', name: trigger, ref }, autoRun: s.autoRun });
  } catch (err) {
    console.error('[jobs] trigger failed', trigger, err instanceof Error ? err.message : err);
  }
}

let started = false;
export function startTriggers(): void {
  if (started) return;
  started = true;
  onIncident((inc) => {
    if (inc.severity !== 'high' && inc.severity !== 'critical') return;
    fire('security-incident', inc.id, `Respond to incident: ${inc.title}`,
      `A ${inc.severity} security incident was opened: "${inc.title}" (rule ${inc.rule}, actor ${inc.actor}). Investigate it using the security-triage skill, check whether anything is still at risk, and recommend containment and next steps. Do not change any settings; recommend them.`);
  });
  telemetry.subscribeAll((e) => {
    if (e.type !== 'alert' || e.alert.severity !== 'fail') return;
    const p = getProject(e.projectId);
    fire('engineering-alert', `${e.projectId}:${e.alert.key}`, `Engineering failure: ${e.alert.message}`.slice(0, 120),
      `Live telemetry on engineering project "${p?.goal ?? e.projectId}" (id ${e.projectId}) raised a failure: ${e.alert.message} (component ${e.alert.componentId}, value ${e.alert.value}${e.alert.simulated ? ', simulated data' : ''}). Re-verify the design with SENTINEL, assess whether the material or section should change, and recommend actions.`);
  });
  onNotification((n, change) => {
    if (change !== 'created') return;
    if (n.kind === 'prospect_reply') fire('prospect-reply', n.id, `Prospect follow-up: ${n.title}`, `${n.title}. ${n.body ?? ''}\nRecall what EVE knows about this prospect and their company, summarize the relationship, and draft a short reply and a recommended next step.`);
    if (n.kind === 'booking') fire('booking', n.id, `Prepare for booking: ${n.title}`, `${n.title}. ${n.body ?? ''}\nRecall the client or prospect from EVE's memory, list open projects and deadlines with them, and prepare a one-page brief for the meeting.`);
    if (n.kind === 'deadline_soon' && /tomorrow|1 day/i.test(n.title)) fire('deadline', n.id, `Deadline tomorrow: ${n.title}`, `${n.title}. ${n.body ?? ''}\nRecall the related project and client from EVE, list what must be finished, and draft a checklist to deliver on time.`);
  });
  a2aBus.onTopic('lead_alert', () => fire('lead-scan', new Date().toISOString().slice(0, 13), 'Qualify new leads', 'The hourly lead scan found new FSBO and motivated-seller leads. Enrich the strongest ones with ARIA, check the properties with TERRA, and rank the top five with a suggested first message for each.'));
  a2aBus.onTopic('fleet_alert', () => fire('fleet-health', new Date().toISOString().slice(0, 15), 'Review robot fleet health', 'Review the latest FORGE fleet status, flag units needing maintenance soon, and recommend a maintenance schedule.'));
  a2aBus.onTopic('security_alert', () => fire('cve-scan', new Date().toISOString().slice(0, 10), 'Triage vulnerability scan', 'The daily MESH vulnerability scan finished. Prioritize findings by severity and exposure and recommend fixes.'));
  a2aBus.onTopic('cost_alert', () => fire('cost-scan', new Date().toISOString().slice(0, 13), 'Review cloud cost report', 'INFRA produced a cost optimization report. Summarize the savings opportunities and recommend which to apply.'));
}
