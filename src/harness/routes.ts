import { Router, type Request, type Response } from 'express';
import { allHarnessConfigs, updateHarness } from './settings.js';
import { contextReport, getRun, recentRuns } from './loop.js';
import { evalRun, evalRuns, listSuites, startEval } from './evals.js';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(/not found|no eval/i.test(msg) ? 404 : 400).json({ error: msg });
  }
};

export const harnessRouter = Router();
harnessRouter.get('/config', h(() => allHarnessConfigs()));
harnessRouter.put('/config/:agent', h((req) => updateHarness(req.params.agent, req.body ?? {})));
harnessRouter.get('/runs', h((req) => recentRuns(Math.min(200, Number(req.query.limit) || 50)).map(({ steps, ...r }) => ({ ...r, stepCount: steps.length, lastContext: steps[steps.length - 1]?.context.total ?? 0 }))));
harnessRouter.get('/runs/:id', h((req) => { const r = getRun(req.params.id); if (!r) throw new Error('Run not found'); return r; }));
harnessRouter.get('/context', h(() => contextReport()));
harnessRouter.get('/evals', h(() => ({ suites: listSuites().map(({ cases, ...s }) => ({ ...s, cases: cases.length })), runs: evalRuns().map(({ results, ...r }) => ({ ...r, summary: results.map((m) => ({ model: m.model, passRate: m.passRate, score: m.score, avgLatencyMs: m.avgLatencyMs, costUsd: m.costUsd })) })) })));
harnessRouter.post('/evals/run', h((req) => startEval(String(req.body?.suite ?? ''), Array.isArray(req.body?.models) ? req.body.models.map(String) : [], req.body?.judge ? String(req.body.judge) : undefined)));
harnessRouter.get('/evals/runs/:id', h((req) => { const r = evalRun(req.params.id); if (!r) throw new Error('Eval run not found'); return r; }));
