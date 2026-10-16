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

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const AGENTS = [
  'ARIA', 'DEVX', 'TERRA', 'CAPITA', 'NOVA', 'TON',
  'NEXUS', 'FORGE', 'ARCH', 'VOLT', 'MOTOR', 'MESH',
  'INFRA', 'PLAT', 'XAAS', 'BRAIN',
] as const;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: [...AGENTS], uptime: process.uptime() });
});

app.post('/dispatch', async (req, res) => {
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

app.post('/ton', async (req, res) => {
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

app.post('/brain', async (req, res) => {
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

const server = http.createServer(app);
startGateway(server);

server.listen(PORT, () => {
  console.log(`welloff-neural-link running on port ${PORT}`);
  console.log(`Agents: ${AGENTS.join(', ')}`);
});
