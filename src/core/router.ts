import type { AgentCommand } from '../types/index.js';
import { handle as aria } from '../agents/ARIA.js';
import { handle as devx } from '../agents/DEVX.js';
import { handle as terra } from '../agents/TERRA.js';
import { handle as capita } from '../agents/CAPITA.js';
import { handle as nova } from '../agents/NOVA.js';
import { handle as ton } from '../agents/TON.js';

const handlers: Record<string, (cmd: AgentCommand) => Promise<unknown>> = {
  ARIA: aria,
  DEVX: devx,
  TERRA: terra,
  CAPITA: capita,
  NOVA: nova,
  TON: ton,
};

export async function route(command: AgentCommand): Promise<unknown> {
  const handler = handlers[command.agentId];
  if (!handler) {
    throw new Error(`No handler registered for agentId "${command.agentId}"`);
  }
  return handler(command);
}
