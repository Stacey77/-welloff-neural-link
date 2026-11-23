import { randomUUID } from 'crypto';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { Router, type Request, type Response } from 'express';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';
import { traced } from '../integrations/langsmith.js';
import { selfTest } from './fea.js';
import { MATERIALS } from './materials.js';
import { nodeDefinitions, runSwarm } from './swarm.js';
import { TelemetryHub, type TelemetryEvent } from './telemetry.js';
import { verifyDesign } from './verify.js';
import type { Priority, Project, ProjectOptions, Reading } from './types.js';

export type * from './types.js';
export { selfTest } from './fea.js';
export { MATERIALS, selectMaterials, getMaterial } from './materials.js';
export { verifyDesign } from './verify.js';
export { nodeDefinitions } from './swarm.js';

const DIR = join(DATA_DIR, 'engineering', 'projects');
const ID_RE = /^[a-z0-9-]{6,40}$/;
const cache = new Map<string, Project>();
const pending = new Map<string, NodeJS.Timeout>();

const fileFor = (id: string) => join(DIR, `${id}.json`);

function load(id: string): Project | null {
  if (!ID_RE.test(id)) return null;
  const hit = cache.get(id);
  if (hit) return hit;
  const p = readJson<Project | null>(fileFor(id), null);
  if (!p) return null;
  p.telemetry.running = false;
  cache.set(id, p);
  return p;
}

// Telemetry mutates projects many times a second; writes are coalesced unless an alert fired.
function save(p: Project, urgent = true): void {
  cache.set(p.id, p);
  const t = pending.get(p.id);
  if (urgent) {
    if (t) { clearTimeout(t); pending.delete(p.id); }
    writeJson(fileFor(p.id), p);
    return;
  }
  if (t) return;
  const timer = setTimeout(() => { pending.delete(p.id); if (cache.has(p.id)) writeJson(fileFor(p.id), cache.get(p.id)); }, 3_000);
  timer.unref?.();
  pending.set(p.id, timer);
}

export const telemetry = new TelemetryHub({ get: load, save });

export async function createProject(goal: string, opts: ProjectOptions = {}): Promise<Project> {
  return traced('engineering.createProject', 'chain', { goal, opts: opts as Record<string, unknown> }, async () => {
    const run = await runSwarm(goal, opts);
    const s = run.state;
    if (!s.plan) throw new Error(`planning failed: ${run.nodes.find((n) => n.id === 'INTENT')?.summary ?? 'unknown error'}`);
    const now = new Date().toISOString();
    const designs = s.plan.components.map((c) => s.designs[c.id]).filter(Boolean);
    const project: Project = {
      id: randomUUID().slice(0, 12),
      goal,
      createdAt: now,
      updatedAt: now,
      planSource: s.planSource,
      planModel: s.planModel,
      planNotes: s.planNotes,
      plan: s.plan,
      swarm: { nodes: run.nodes, levels: run.levels, ms: run.ms },
      designs,
      compliance: { compliant: !s.findings.some((f) => f.severity === 'fail') && designs.length === s.plan.components.length, findings: s.findings, rulesApplied: s.rulesApplied, references: s.references },
      report: s.report,
      verification: verifyDesign({ plan: s.plan, designs }),
      telemetry: { running: false, simulated: false, channels: s.channels, latest: {} },
      alerts: [],
    };
    save(project);
    return project;
  }, { outputs: (p) => ({ id: p.id, planSource: p.planSource, overall: p.verification.overall }) });
}

export function listProjects() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => load(f.slice(0, -5))).filter((p): p is Project => !!p)
    .map((p) => ({
      id: p.id, goal: p.goal, createdAt: p.createdAt, updatedAt: p.updatedAt, planSource: p.planSource,
      components: p.plan.components.length, overall: (p.telemetry.lastVerification ?? p.verification).overall,
      compliant: p.compliance.compliant, openAlerts: p.alerts.filter((a) => !a.clearedAt).length, running: telemetry.isRunning(p.id),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getProject(id: string): Project | null {
  const p = load(id);
  if (p) p.telemetry.running = telemetry.isRunning(id);
  return p;
}

export function deleteProject(id: string): boolean {
  const p = load(id);
  if (!p) return false;
  telemetry.forget(id);
  const t = pending.get(id);
  if (t) clearTimeout(t);
  pending.delete(id);
  cache.delete(id);
  rmSync(fileFor(id), { force: true });
  return true;
}

export function startSimulation(id: string, intervalMs = 1000): Project | null {
  if (!load(id)) return null;
  telemetry.startSimulation(id, intervalMs);
  return getProject(id);
}

export function stopSimulation(id: string): Project | null {
  if (!load(id)) return null;
  telemetry.stopSimulation(id);
  return getProject(id);
}

export function ingest(id: string, readings: Reading[]) {
  if (!load(id)) return null;
  return telemetry.ingest(id, readings, false);
}

export function subscribe(id: string, fn: (e: TelemetryEvent) => void): () => void {
  return telemetry.subscribe(id, fn);
}

// Re-runs design-load verification plus, when telemetry exists, verification at the latest readings.
export function reverify(id: string) {
  const p = load(id);
  if (!p) return null;
  p.verification = verifyDesign(p);
  const live = Object.keys(p.telemetry.latest).length ? telemetry.ingest(id, [], p.telemetry.simulated).verification : undefined;
  save(p);
  return { design: p.verification, live };
}

/* ── HTTP ── */

const PRIORITIES: Priority[] = ['mass', 'cost', 'balanced'];

function parseOptions(body: Record<string, unknown>): ProjectOptions | string {
  const opts: ProjectOptions = {};
  if (body.targetSafetyFactor !== undefined) {
    const v = Number(body.targetSafetyFactor);
    if (!Number.isFinite(v) || v < 1.1 || v > 10) return 'targetSafetyFactor must be a number between 1.1 and 10';
    opts.targetSafetyFactor = v;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority as Priority)) return `priority must be one of ${PRIORITIES.join(', ')}`;
    opts.priority = body.priority as Priority;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.length > 200) return 'model must be a model spec string';
    opts.model = body.model;
  }
  if (body.llm !== undefined) {
    if (typeof body.llm !== 'boolean') return 'llm must be a boolean';
    opts.llm = body.llm;
  }
  return opts;
}

function validGoal(goal: unknown): string | null {
  return typeof goal === 'string' && goal.trim().length >= 5 && goal.length <= 2000 ? goal.trim() : null;
}

function validReadings(v: unknown): Reading[] | string {
  if (!Array.isArray(v) || !v.length) return 'readings must be a non-empty array of {channel, value, unit?, at?}';
  if (v.length > 5000) return 'at most 5000 readings per request';
  for (const r of v) {
    if (!r || typeof r !== 'object' || typeof (r as Reading).channel !== 'string' || typeof (r as Reading).value !== 'number') return 'each reading needs a string channel and a numeric value';
  }
  return v as Reading[];
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const engineeringRouter = Router();

engineeringRouter.get('/projects', (_req, res) => { res.json({ projects: listProjects() }); });

engineeringRouter.post('/projects', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const goal = validGoal(body.goal);
  if (!goal) { res.status(400).json({ error: 'goal must be a string of 5 to 2000 characters' }); return; }
  const opts = parseOptions(body);
  if (typeof opts === 'string') { res.status(400).json({ error: opts }); return; }
  try {
    res.status(201).json(await createProject(goal, opts));
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

engineeringRouter.get('/projects/:id', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) { res.status(404).json({ error: 'project not found' }); return; }
  res.json(p);
});

engineeringRouter.delete('/projects/:id', (req, res) => {
  if (!deleteProject(req.params.id)) { res.status(404).json({ error: 'project not found' }); return; }
  res.json({ ok: true });
});

engineeringRouter.post('/projects/:id/simulate', (req, res) => {
  const on = (req.body ?? {}).on;
  if (typeof on !== 'boolean') { res.status(400).json({ error: 'body must be {"on": true|false}' }); return; }
  const p = on ? startSimulation(req.params.id) : stopSimulation(req.params.id);
  if (!p) { res.status(404).json({ error: 'project not found' }); return; }
  res.json({ id: p.id, running: p.telemetry.running, simulated: p.telemetry.simulated });
});

engineeringRouter.post('/projects/:id/telemetry', (req, res) => {
  const readings = validReadings((req.body ?? {}).readings);
  if (typeof readings === 'string') { res.status(400).json({ error: readings }); return; }
  const r = ingest(req.params.id, readings);
  if (!r) { res.status(404).json({ error: 'project not found' }); return; }
  if (!r.accepted) { res.status(400).json({ error: 'no reading was accepted', rejected: r.rejected }); return; }
  res.json(r);
});

engineeringRouter.get('/projects/:id/history', (req, res) => {
  if (!getProject(req.params.id)) { res.status(404).json({ error: 'project not found' }); return; }
  res.json(telemetry.history(req.params.id, typeof req.query.channel === 'string' ? req.query.channel : undefined));
});

engineeringRouter.get('/projects/:id/stream', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) { res.status(404).json({ error: 'project not found' }); return; }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
  send({ type: 'status', projectId: p.id, running: p.telemetry.running, simulated: p.telemetry.simulated, channels: p.telemetry.channels });
  if (p.telemetry.lastVerification) send({ type: 'verification', projectId: p.id, report: p.telemetry.lastVerification });
  const unsubscribe = subscribe(p.id, send);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
  res.on('error', cleanup);
});

engineeringRouter.get('/materials', (_req, res) => { res.json({ materials: MATERIALS }); });
engineeringRouter.get('/swarm', (_req, res) => { res.json({ nodes: nodeDefinitions() }); });
engineeringRouter.get('/selftest', (_req, res) => { res.json(selfTest()); });
