import { Router, type Request, type Response, type NextFunction } from 'express';
import { apiKeyAuth } from '../middleware/auth.js';
import { listTree, readSrc, writeSrc, runTypecheck } from './workspace.js';
import { listEnv, setEnv, deleteEnv } from './env.js';
import { createTask, listTasks, getTask, cancelTask, resolveEdit, deleteTask } from './tasks.js';
import {
  createDeployment, listDeployments, getDeployment, promote, restart, stop, remove, providerStatus, productionUrl,
  type Provider, type Target,
} from './deploy.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  return hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
}

// File writes, env edits and deploys run code on this machine, so the IDE API only
// accepts same-origin calls, and only loopback hosts unless NEURAL_API_KEY is set.
function guard(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NL_DEPLOYMENT_ID) {
    res.status(403).json({ error: 'The IDE API is disabled inside deployments.' });
    return;
  }
  const origin = req.headers.origin;
  const extra = (process.env.NL_IDE_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && origin !== `${req.protocol}://${req.headers.host}` && !extra.includes(origin)) {
    res.status(403).json({ error: `Requests from ${origin} are not allowed. Add it to NL_IDE_ALLOWED_ORIGINS to permit it.` });
    return;
  }
  if (!process.env.NEURAL_API_KEY && !LOCAL_HOSTS.has(hostname(req.headers.host))) {
    res.status(403).json({ error: 'The IDE API is local-only. Set NEURAL_API_KEY to allow remote access.' });
    return;
  }
  apiKeyAuth(req, res, next);
}

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

export const ideRouter = Router();
ideRouter.use(guard);

ideRouter.get('/fs/tree', h(() => ({ root: 'src', tree: listTree() })));
ideRouter.get('/fs/file', h((req) => ({ path: req.query.path, content: readSrc(String(req.query.path ?? '')) })));
ideRouter.put('/fs/file', h((req) => {
  const { path, content } = req.body ?? {};
  if (typeof path !== 'string' || typeof content !== 'string') throw new Error('path and content are required');
  writeSrc(path, content);
  return { saved: true, path, bytes: Buffer.byteLength(content) };
}));
ideRouter.post('/build', h(() => runTypecheck()));

ideRouter.get('/env', h(() => ({ vars: listEnv(), note: 'Changes apply to new deployments and the next server restart.' })));
ideRouter.put('/env', h((req) => {
  const { key, value } = req.body ?? {};
  if (typeof key !== 'string' || typeof value !== 'string') throw new Error('key and value are required');
  setEnv(key.trim(), value);
  return { saved: true, key };
}));
ideRouter.delete('/env/:key', h((req) => {
  if (!deleteEnv(req.params.key)) throw new Error('Variable not found');
  return { deleted: true };
}));

ideRouter.get('/tasks', h(() => listTasks()));
ideRouter.post('/tasks', h((req) => {
  const { prompt, contextFile, autoApply } = req.body ?? {};
  return createTask(String(prompt ?? ''), { contextFile, autoApply });
}));
ideRouter.get('/tasks/:id', h((req) => {
  const t = getTask(req.params.id);
  if (!t) throw new Error('Task not found');
  return t;
}));
ideRouter.post('/tasks/:id/cancel', h((req) => cancelTask(req.params.id)));
ideRouter.post('/tasks/:id/edits/:artifactId/accept', h((req) => resolveEdit(req.params.id, req.params.artifactId, true)));
ideRouter.post('/tasks/:id/edits/:artifactId/reject', h((req) => resolveEdit(req.params.id, req.params.artifactId, false)));
ideRouter.delete('/tasks/:id', h((req) => { deleteTask(req.params.id); return { deleted: true }; }));

const PROVIDERS: Provider[] = ['local', 'netlify', 'vercel'];
ideRouter.get('/deployments', h(() => ({ productionUrl: productionUrl(), providers: providerStatus(), deployments: listDeployments() })));
ideRouter.post('/deployments', h(async (req) => {
  const provider = (req.body?.provider ?? 'local') as Provider;
  const target = (req.body?.target === 'production' ? 'production' : 'preview') as Target;
  if (!PROVIDERS.includes(provider)) throw new Error('provider must be local, netlify or vercel');
  return createDeployment(provider, target);
}));
ideRouter.get('/deployments/:id', h((req) => {
  const d = getDeployment(req.params.id);
  if (!d) throw new Error('Deployment not found');
  return d;
}));
ideRouter.post('/deployments/:id/promote', h((req) => promote(req.params.id)));
ideRouter.post('/deployments/:id/restart', h((req) => restart(req.params.id)));
ideRouter.post('/deployments/:id/stop', h((req) => stop(req.params.id)));
ideRouter.delete('/deployments/:id', h((req) => { remove(req.params.id); return { deleted: true }; }));
