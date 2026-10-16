import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { route } from '../core/router.js';
import { push } from '../core/memory.js';
import { AgentCommandSchema } from '../types/index.js';
import type { AgentResult, NeuralEvent } from '../types/index.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

function send(ws: WebSocket, event: NeuralEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function broadcast(wss: WebSocketServer, event: NeuralEvent): void {
  wss.clients.forEach((client) => send(client, event));
}

export function startGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server });

  const heartbeat = setInterval(() => {
    broadcast(wss, { type: 'heartbeat', timestamp: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    ws.on('message', async (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send(ws, { type: 'broadcast', message: 'Invalid JSON', from: 'TON' });
        return;
      }

      const validation = AgentCommandSchema.safeParse(parsed);
      if (!validation.success) {
        send(ws, {
          type: 'broadcast',
          message: `Invalid command: ${JSON.stringify(validation.error.flatten())}`,
          from: 'TON',
        });
        return;
      }

      const command = validation.data;
      const start = Date.now();

      let agentResult: AgentResult;
      try {
        const result = await route(command);
        agentResult = {
          commandId: command.id,
          agentId: command.agentId,
          status: 'success',
          result,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        agentResult = {
          commandId: command.id,
          agentId: command.agentId,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - start,
        };
      }

      push(agentResult);
      broadcast(wss, { type: 'result', payload: agentResult });
    });
  });

  return wss;
}

export function buildDispatchId(): string {
  return randomUUID();
}
