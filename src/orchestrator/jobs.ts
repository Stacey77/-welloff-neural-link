import { join } from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';
import { route } from '../core/router.js';
import { AgentIdSchema, type AgentId } from '../types/index.js';
import { ask, LlmSession } from '../llm/index.js';
import { runLoop } from '../harness/loop.js';
import { platformTools, runPlatformTool } from '../tools/access.js';
import { a2aBus } from '../a2a/bus.js';
import { capture } from '../security/governance.js';
import { traced } from '../integrations/langsmith.js';
import { notify } from '../assistant/notify.js';
import { REGISTRY, capability, isAction, registryText } from './registry.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'awaiting_approval' | 'rejected' | 'skipped';
export type JobStatus = 'awaiting_start' | 'planning' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';

export interface JobTask {
  id: string;
  agent: string;
  command?: string;
  params?: Record<string, unknown>;
  role?: string;
  instructions?: string;
  dependsOn: string[];
  purpose: string;
  action: boolean;
  status: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  report?: { summary: string; model?: string; runId?: string };
  error?: string;
}

export interface Job {
  id: string;
  title: string;
  input: string;
  source: { type: 'manual' | 'webhook' | 'trigger'; name?: string; ref?: string };
  status: JobStatus;
  autoApprove: boolean;
  createdAt: number;
  updatedAt: number;
  plan?: { summary: string; source: 'llm' | 'rules'; model?: string; note?: string };
  tasks: JobTask[];
  reports: { at: number; from: string; taskId: string; summary: string }[];
  final?: { text: string; model?: string; at: number };
  error?: string;
}

const FILE = join(DATA_DIR, 'orchestrator', 'jobs.json');
const MAX_JOBS = 300;
const MAX_RUNNING = 3;
const MAX_TASKS = 8;

let jobs: Job[] = readJson<Job[]>(FILE, []).map((j) =>
  ['planning', 'running'].includes(j.status)
    ? { ...j, status: 'failed', error: 'Interrupted by a server restart', tasks: j.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'failed', error: 'Interrupted by a server restart' } : t)) }
    : j,
);
let saveTimer: NodeJS.Timeout | undefined;
function save(): void {
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = undefined; writeJson(FILE, jobs.slice(0, MAX_JOBS)); }, 250);
}
process.once('exit', () => writeJson(FILE, jobs.slice(0, MAX_JOBS)));

const listeners = new Set<(j: Job) => void>();
export function onJob(fn: (j: Job) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function touch(j: Job): void {
  j.updatedAt = Date.now();
  save();
  for (const fn of listeners) { try { fn(j); } catch { /* listeners never block jobs */ } }
}

/* ── Planning ── */

const PLANNER_SYSTEM = `You are TON, the head orchestrator. Break a job into tasks for specialist agents and subagents, which run automatically and report back to you.

Agents you can assign (use only these agents and commands):
${registryText()}

You can also assign a SUBAGENT: a general AI worker with a role and instructions that can search and call platform tools and read skills. Use one for research, analysis, drafting or anything no specialist covers.

Rules:
- At most ${MAX_TASKS} tasks. Prefer fewer, well-chosen tasks.
- Tasks run in parallel unless dependsOn lists earlier task ids whose output they need.
- Prefer read-only commands. Use a command that needs approval only when the job clearly asks for that action.
- params is the command's input; include "message" with the relevant text for agents that take free text (NATURA, BRAIN, MAESTRO uses "prompt").
- Reply with JSON only:
{"summary":"one sentence plan","tasks":[{"id":"t1","agent":"ARIA","command":"findLeads","params":{},"dependsOn":[],"purpose":"why"},{"id":"t2","agent":"SUBAGENT","role":"Market analyst","instructions":"what to do and what to report","dependsOn":["t1"],"purpose":"why"}]}`;

function rulesPlan(input: string): { summary: string; tasks: JobTask[] } {
  const text = input.toLowerCase();
  const scored = REGISTRY.map((c) => ({ c, score: c.keywords.filter((k) => text.includes(k)).length })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  const tasks: JobTask[] = scored.map(({ c }, i) => ({
    id: `t${i + 1}`, agent: c.agent, command: c.defaultCommand,
    params: { message: input, prompt: input, query: input, goal: input },
    dependsOn: [], purpose: `Matched ${c.agent}: ${c.description}`, action: isAction(c.agent, c.defaultCommand), status: 'pending',
  }));
  if (!tasks.length) {
    tasks.push({ id: 't1', agent: 'SUBAGENT', role: 'Analyst', instructions: input, dependsOn: [], purpose: 'No specialist matched, so a general subagent handles it', action: false, status: 'pending' });
  }
  return { summary: `Keyword routing to ${tasks.map((t) => t.agent).join(', ')}`, tasks };
}

function validatePlan(raw: any): { summary: string; tasks: JobTask[] } {
  const list: any[] = Array.isArray(raw?.tasks) ? raw.tasks.slice(0, MAX_TASKS) : [];
  const ids = new Set<string>();
  const tasks: JobTask[] = [];
  for (const [i, t] of list.entries()) {
    const id = String(t?.id || `t${i + 1}`).slice(0, 20);
    if (ids.has(id)) continue;
    const agent = String(t?.agent ?? '').toUpperCase();
    const deps = (Array.isArray(t?.dependsOn) ? t.dependsOn : []).map(String).filter((d: string) => ids.has(d));
    if (agent === 'SUBAGENT') {
      if (!t?.instructions) continue;
      tasks.push({ id, agent, role: String(t.role || 'Analyst').slice(0, 60), instructions: String(t.instructions).slice(0, 4_000), dependsOn: deps, purpose: String(t.purpose ?? ''), action: false, status: 'pending' });
    } else {
      const cap = capability(agent);
      if (!cap) continue;
      const command = [...cap.read, ...cap.act].includes(String(t?.command)) ? String(t.command) : cap.defaultCommand;
      const params = t?.params && typeof t.params === 'object' && !Array.isArray(t.params) ? t.params : {};
      tasks.push({ id, agent, command, params, dependsOn: deps, purpose: String(t?.purpose ?? ''), action: isAction(agent, command), status: 'pending' });
    }
    ids.add(id);
  }
  if (!tasks.length) throw new Error('The plan had no valid tasks');
  return { summary: String(raw?.summary ?? 'Plan').slice(0, 300), tasks };
}

async function planJob(j: Job): Promise<void> {
  j.status = 'planning';
  touch(j);
  try {
    const r = await ask('TON', `Job: ${j.input}`, { system: PLANNER_SYSTEM, maxTokens: 4_000 });
    const m = r.text.match(/\{[\s\S]*\}/);
    const plan = validatePlan(m ? JSON.parse(m[0]) : null);
    j.plan = { summary: plan.summary, source: 'llm', model: r.spec };
    j.tasks = plan.tasks;
  } catch (err) {
    const plan = rulesPlan(j.input);
    j.plan = { summary: plan.summary, source: 'rules', note: `Model planning unavailable: ${err instanceof Error ? err.message : String(err)}` };
    j.tasks = plan.tasks;
  }
}

/* ── Execution ── */

function summarize(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 2_000);
  const r = (result ?? {}) as Record<string, unknown>;
  const text = r.summary ?? r.response ?? r.answer ?? r.analysis ?? r.reply;
  if (typeof text === 'string' && text.trim()) return text.slice(0, 2_000);
  return JSON.stringify(result).slice(0, 1_500);
}

function dependencyContext(j: Job, t: JobTask): string {
  return t.dependsOn.map((id) => j.tasks.find((x) => x.id === id)).filter(Boolean)
    .map((d) => `[${d!.id} · ${d!.agent}${d!.command ? `.${d!.command}` : ''}] ${d!.report?.summary ?? d!.error ?? ''}`).join('\n\n');
}

async function runSubagent(j: Job, t: JobTask): Promise<{ summary: string; model?: string; runId?: string }> {
  const ctx = dependencyContext(j, t);
  const session = new LlmSession('SUBAGENT', `${t.role}: ${t.instructions}`);
  const r = await runLoop({
    agent: 'SUBAGENT', session, maxTokens: 8_000,
    system: `You are a ${t.role} subagent working for TON, the head orchestrator, on this job: "${j.title}". Do your part using the tools available (search_tools, call_tool, list_skills, load_skill). Do not take actions that spend money, deploy, send messages or change records; describe them as recommendations instead. Finish with a concise report for TON: findings, evidence, and recommended next steps.`,
    tools: await platformTools(),
    messages: [{ role: 'user', content: `${t.instructions}${ctx ? `\n\nResults from earlier tasks:\n${ctx}` : ''}` }],
    execute: async (call) => JSON.stringify(await runPlatformTool(call.name, call.input, 'SUBAGENT')),
  });
  return { summary: r.text || 'No findings.', model: r.models[r.models.length - 1], runId: r.runId };
}

async function runTask(j: Job, t: JobTask): Promise<void> {
  t.status = 'running';
  t.startedAt = Date.now();
  touch(j);
  try {
    let report: JobTask['report'];
    if (t.agent === 'SUBAGENT') {
      report = await traced(`SUBAGENT ${t.role}`, 'chain', { job: j.id, task: t.id, instructions: t.instructions }, () => runSubagent(j, t));
    } else {
      const agentId = AgentIdSchema.parse(t.agent) as AgentId;
      const ctx = dependencyContext(j, t);
      const params: Record<string, unknown> = { ...t.params, ...(ctx ? { _dependencyResults: ctx } : {}) };
      if (capability(t.agent)?.messageParam && typeof params.message !== 'string') params.message = j.input;
      const result = await route({ id: randomUUID(), agentId, command: t.command!, params, timestamp: Date.now() });
      report = { summary: summarize(result) };
    }
    t.report = report;
    t.status = 'done';
  } catch (err) {
    t.status = 'failed';
    t.error = err instanceof Error ? err.message : String(err);
  }
  t.endedAt = Date.now();
  const summary = t.report?.summary ?? `Failed: ${t.error}`;
  j.reports.push({ at: Date.now(), from: t.agent, taskId: t.id, summary });
  // Every task reports to the head orchestrator over the A2A bus.
  a2aBus.broadcast((t.agent === 'SUBAGENT' ? 'TON' : t.agent) as AgentId, 'job.report', { jobId: j.id, taskId: t.id, to: 'TON', from: t.agent === 'SUBAGENT' ? `SUBAGENT:${t.role}` : t.agent, status: t.status, summary: summary.slice(0, 500) });
  touch(j);
}

async function synthesize(j: Job): Promise<void> {
  const lines = j.tasks.map((t) => `[${t.id} · ${t.agent === 'SUBAGENT' ? `subagent ${t.role}` : `${t.agent}.${t.command}`} · ${t.status}] ${t.report?.summary ?? t.error ?? (t.status === 'rejected' ? 'Not approved.' : t.status === 'skipped' ? 'Skipped because a dependency did not finish.' : '')}`);
  try {
    const r = await ask('TON', `Job: ${j.input}\n\nReports from your agents:\n${lines.join('\n\n')}\n\nWrite the final report to the owner: what was found, what was done, what still needs a decision (list any actions waiting for approval or rejected), and recommended next steps. Be concise and do not invent results that are not in the reports.`, { maxTokens: 3_000 });
    j.final = { text: r.text, model: r.spec, at: Date.now() };
  } catch {
    j.final = { text: `Reports for "${j.title}":\n\n${lines.join('\n')}`, at: Date.now() };
  }
}

const active = new Set<string>();
const queue: string[] = [];

async function drive(jobId: string): Promise<void> {
  const j = getJob(jobId);
  if (!j || ['done', 'failed', 'cancelled', 'awaiting_start'].includes(j.status)) return;
  if (active.has(jobId)) return;
  if (active.size >= MAX_RUNNING) { if (!queue.includes(jobId)) queue.push(jobId); return; }
  active.add(jobId);
  try {
    await traced(`job ${j.title}`, 'chain', { job: j.id, input: j.input }, async () => {
      if (!j.tasks.length) await planJob(j);
      j.status = 'running';
      touch(j);
      for (;;) {
        if ((j.status as JobStatus) === 'cancelled') return;
        for (const t of j.tasks) {
          if (t.status !== 'pending') continue;
          const deps = t.dependsOn.map((id) => j.tasks.find((x) => x.id === id)!).filter(Boolean);
          if (deps.some((d) => ['failed', 'rejected', 'skipped'].includes(d.status))) { t.status = 'skipped'; continue; }
          if (t.action && !j.autoApprove && deps.every((d) => d.status === 'done')) t.status = 'awaiting_approval';
        }
        const ready = j.tasks.filter((t) => t.status === 'pending' && t.dependsOn.every((id) => j.tasks.find((x) => x.id === id)?.status === 'done'));
        if (!ready.length) break;
        await Promise.all(ready.map((t) => runTask(j, t)));
      }
      if (j.tasks.some((t) => t.status === 'awaiting_approval')) {
        j.status = 'awaiting_approval';
        touch(j);
        return;
      }
      await synthesize(j);
      j.status = j.tasks.every((t) => t.status === 'failed' || t.status === 'skipped') ? 'failed' : 'done';
      a2aBus.broadcast('TON', 'job.done', { jobId: j.id, title: j.title, status: j.status });
      capture('agent_run', 'TON', `Job ${j.status}: ${j.title}`, j.final?.text ?? '', { jobId: j.id, tasks: j.tasks.map((t) => `${t.agent}:${t.status}`) });
      notify({ kind: 'info', title: `Job ${j.status === 'done' ? 'finished' : 'failed'}: ${j.title}`, body: (j.final?.text ?? '').slice(0, 280), key: `job:${j.id}:${j.status}` });
      touch(j);
    });
  } catch (err) {
    j.status = 'failed';
    j.error = err instanceof Error ? err.message : String(err);
    touch(j);
  } finally {
    active.delete(jobId);
    const next = queue.shift();
    if (next) void drive(next);
  }
}

/* ── Public API ── */

export interface CreateJobOptions { title?: string; source?: Job['source']; autoRun?: boolean; autoApprove?: boolean; tasks?: Omit<JobTask, 'status' | 'action'>[] }

export function createJob(input: string, opts: CreateJobOptions = {}): Job {
  const text = input.trim();
  if (text.length < 3) throw new Error('Describe the job in a few words.');
  const j: Job = {
    id: `job_${randomUUID().slice(0, 8)}`,
    title: (opts.title ?? text.split('\n')[0]).slice(0, 120),
    input: text.slice(0, 8_000),
    source: opts.source ?? { type: 'manual' },
    status: opts.autoRun === false ? 'awaiting_start' : 'planning',
    autoApprove: Boolean(opts.autoApprove),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks: opts.tasks ? validatePlan({ tasks: opts.tasks }).tasks : [],
    reports: [],
  };
  if (opts.tasks) j.plan = { summary: 'Plan supplied with the job', source: 'rules' };
  jobs.unshift(j);
  if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;
  touch(j);
  if (j.status !== 'awaiting_start') void drive(j.id);
  return j;
}

export function listJobs(limit = 100) { return jobs.slice(0, limit); }
export function getJob(id: string) { return jobs.find((j) => j.id === id); }

export function startJob(id: string): Job {
  const j = getJob(id);
  if (!j) throw new Error('Job not found');
  if (j.status !== 'awaiting_start') throw new Error(`Job is ${j.status}`);
  j.status = 'planning';
  touch(j);
  void drive(id);
  return j;
}

export function decide(id: string, taskId: string | 'all', approve: boolean): Job {
  const j = getJob(id);
  if (!j) throw new Error('Job not found');
  const targets = j.tasks.filter((t) => t.status === 'awaiting_approval' && (taskId === 'all' || t.id === taskId));
  if (!targets.length) throw new Error('Nothing is waiting for approval');
  for (const t of targets) {
    t.status = approve ? 'pending' : 'rejected';
    j.reports.push({ at: Date.now(), from: 'owner', taskId: t.id, summary: `${approve ? 'Approved' : 'Rejected'} ${t.agent}.${t.command}` });
    capture('agent_run', 'owner', `${approve ? 'Approved' : 'Rejected'} ${t.agent}.${t.command} in job ${j.id}`, JSON.stringify(t.params ?? {}).slice(0, 2_000));
  }
  // Approved actions run with approval already given, so the gate does not re-trigger.
  for (const t of targets) if (approve) t.action = false;
  j.status = 'running';
  touch(j);
  void drive(id);
  return j;
}

export function cancelJob(id: string): Job {
  const j = getJob(id);
  if (!j) throw new Error('Job not found');
  if (['done', 'failed', 'cancelled'].includes(j.status)) throw new Error(`Job is already ${j.status}`);
  j.status = 'cancelled';
  for (const t of j.tasks) if (['pending', 'awaiting_approval'].includes(t.status)) t.status = 'skipped';
  touch(j);
  return j;
}

export function deleteJob(id: string): void {
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) throw new Error('Job not found');
  if (active.has(id)) throw new Error('Cancel the job before deleting it');
  jobs.splice(i, 1);
  save();
}
