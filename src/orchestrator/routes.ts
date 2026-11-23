import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { envValue } from '../llm/catalog.js';
import { cancelJob, createJob, decide, deleteJob, getJob, listJobs, startJob } from './jobs.js';
import { triggerSettings, updateTrigger } from './triggers.js';
import { REGISTRY } from './registry.js';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(/not found/i.test(msg) ? 404 : 400).json({ error: msg });
  }
};

export const jobsRouter = Router();
jobsRouter.get('/', h((req) => ({ jobs: listJobs(Math.min(300, Number(req.query.limit) || 100)), triggers: triggerSettings(), webhookSecretSet: Boolean(envValue('JOBS_WEBHOOK_SECRET')) })));
jobsRouter.post('/', h((req) => createJob(String(req.body?.input ?? ''), { title: req.body?.title, autoRun: req.body?.autoRun !== false, autoApprove: Boolean(req.body?.autoApprove), tasks: req.body?.tasks })));
jobsRouter.get('/registry', h(() => REGISTRY));
jobsRouter.get('/:id', h((req) => { const j = getJob(req.params.id); if (!j) throw new Error('Job not found'); return j; }));
jobsRouter.post('/:id/start', h((req) => startJob(req.params.id)));
jobsRouter.post('/:id/approve', h((req) => decide(req.params.id, String(req.body?.taskId ?? 'all'), true)));
jobsRouter.post('/:id/reject', h((req) => decide(req.params.id, String(req.body?.taskId ?? 'all'), false)));
jobsRouter.post('/:id/cancel', h((req) => cancelJob(req.params.id)));
jobsRouter.delete('/:id', h((req) => { deleteJob(req.params.id); return { deleted: true }; }));
jobsRouter.put('/triggers/:id', h((req) => updateTrigger(req.params.id, req.body ?? {})));

// Inbound jobs from other systems. Never auto-approves actions.
export const jobsWebhookRouter = Router();
jobsWebhookRouter.post('/', h((req, res) => {
  const expected = envValue('JOBS_WEBHOOK_SECRET');
  if (!expected) { res.status(503).json({ error: 'Set JOBS_WEBHOOK_SECRET under Environment to accept jobs by webhook.' }); return; }
  const auth = String(req.headers.authorization ?? '');
  const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-webhook-secret'] ?? ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) { res.status(401).json({ error: 'unauthorized' }); return; }
  const j = createJob(String(req.body?.input ?? req.body?.job ?? ''), { title: req.body?.title, source: { type: 'webhook', name: String(req.body?.source ?? 'webhook') } });
  return { ok: true, id: j.id, status: j.status };
}));
