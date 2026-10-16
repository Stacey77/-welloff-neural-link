import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { mcpRouter } from './mcp/server.js';
import { startGateway } from './ws/gateway.js';
import { route } from './core/router.js';
import { push, summary } from './core/memory.js';
import { DispatchRequestSchema, TonRequestSchema } from './types/index.js';
import type { AgentResult } from './types/index.js';
import { a2aBus } from './a2a/bus.js';
import { apiKeyAuth, auditLog } from './middleware/auth.js';
import { getMetrics } from './observability/metrics.js';
import { startScheduler, getSchedulerStatus } from './scheduler/index.js';
import { streamTon } from './stream/sse.js';
import { executeDag } from './workflow/dag.js';
import type { DagPlan } from './workflow/dag.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { ideRouter } from './ide/routes.js';
import { initDeployments } from './ide/deploy.js';
import { wrapPage } from './ide/static-site.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const AGENTS = [
  'ARIA', 'DEVX', 'TERRA', 'CAPITA', 'NOVA', 'TON',
  'NEXUS', 'FORGE', 'ARCH', 'VOLT', 'MOTOR', 'MESH',
  'INFRA', 'PLAT', 'XAAS', 'BRAIN', 'GENESIS', 'NATURA',
] as const;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(auditLog);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: [...AGENTS], uptime: process.uptime() });
});

app.get('/metrics', (_req, res) => {
  res.json(getMetrics());
});

app.get('/stream/ton', (req, res) => {
  void streamTon(req, res);
});

app.get('/scheduler', (_req, res) => {
  res.json(getSchedulerStatus());
});

app.post('/workflow', apiKeyAuth, async (req, res) => {
  const plan = req.body as DagPlan;
  if (!plan?.steps?.length) {
    res.status(400).json({ error: 'steps array required' });
    return;
  }
  try {
    const execution = await executeDag(plan);
    res.json(execution);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/dispatch', apiKeyAuth, async (req, res) => {
  const parsed = DispatchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { agentId, command, params } = parsed.data;
  const cmd = {
    id: randomUUID(),
    agentId,
    command,
    params,
    timestamp: Date.now(),
  };

  const start = Date.now();
  let agentResult: AgentResult;

  try {
    const result = await route(cmd);
    agentResult = {
      commandId: cmd.id,
      agentId,
      status: 'success',
      result,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    agentResult = {
      commandId: cmd.id,
      agentId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }

  push(agentResult);
  const statusCode = agentResult.status === 'success' ? 200 : 500;
  res.status(statusCode).json(agentResult);
});

app.post('/ton', apiKeyAuth, async (req, res) => {
  const parsed = TonRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const cmd = {
    id: randomUUID(),
    agentId: 'TON' as const,
    command: 'dispatch',
    params: { message: parsed.data.message },
    timestamp: Date.now(),
  };

  const start = Date.now();
  let agentResult: AgentResult;

  try {
    const result = await route(cmd);
    agentResult = {
      commandId: cmd.id,
      agentId: 'TON',
      status: 'success',
      result,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    agentResult = {
      commandId: cmd.id,
      agentId: 'TON',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }

  push(agentResult);
  const statusCode = agentResult.status === 'success' ? 200 : 500;
  res.status(statusCode).json(agentResult);
});

app.get('/memory', (_req, res) => {
  res.json(summary());
});

app.post('/brain', apiKeyAuth, async (req, res) => {
  const parsed = TonRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const cmd = {
    id: randomUUID(),
    agentId: 'BRAIN' as const,
    command: 'reason',
    params: { message: parsed.data.message },
    timestamp: Date.now(),
  };

  const start = Date.now();
  let agentResult: AgentResult;

  try {
    const result = await route(cmd);
    agentResult = { commandId: cmd.id, agentId: 'BRAIN', status: 'success', result, latencyMs: Date.now() - start };
  } catch (err) {
    agentResult = { commandId: cmd.id, agentId: 'BRAIN', status: 'error', error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }

  push(agentResult);
  res.status(agentResult.status === 'success' ? 200 : 500).json(agentResult);
});

app.get('/a2a/log', (_req, res) => {
  res.json(a2aBus.getLog(100));
});

app.use('/mcp', mcpRouter);

app.use('/ide/api', ideRouter);
function sendPage(file: string) {
  return (_req: express.Request, res: express.Response) => {
    res.type('html').send(wrapPage(readFileSync(join(__dirname, '..', file), 'utf8')));
  };
}
const isDeployment = Boolean(process.env.NL_DEPLOYMENT_ID);
app.get('/', sendPage(isDeployment ? 'index.html' : 'ide.html'));
app.get('/ide', sendPage('ide.html'));
app.get('/dashboard', sendPage('index.html'));

const server = http.createServer(app);
startGateway(server);
if (process.env.NL_SCHEDULER !== 'off') startScheduler();

server.listen(PORT, () => {
  console.log(`welloff-neural-link running on port ${PORT}`);
  console.log(`Agents: ${AGENTS.join(', ')}`);
  if (!isDeployment) {
    initDeployments();
    console.log(`IDE: http://localhost:${PORT}`);
  }
});
