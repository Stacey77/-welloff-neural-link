import type { AgentCommand } from '../types/index.js';
import { handle as aria } from '../agents/ARIA.js';
import { handle as devx } from '../agents/DEVX.js';
import { handle as terra } from '../agents/TERRA.js';
import { handle as capita } from '../agents/CAPITA.js';
import { handle as nova } from '../agents/NOVA.js';
import { handle as ton } from '../agents/TON.js';
import { handle as nexus } from '../agents/NEXUS.js';
import { handle as forge } from '../agents/FORGE.js';
import { handle as arch } from '../agents/ARCH.js';
import { handle as volt } from '../agents/VOLT.js';
import { handle as motor } from '../agents/MOTOR.js';
import { handle as mesh } from '../agents/MESH.js';
import { handle as infra } from '../agents/INFRA.js';
import { handle as plat } from '../agents/PLAT.js';
import { handle as xaas } from '../agents/XAAS.js';
import { handle as brain } from '../agents/BRAIN.js';

const handlers: Record<string, (cmd: AgentCommand) => Promise<unknown>> = {
  ARIA: aria,
  DEVX: devx,
  TERRA: terra,
  CAPITA: capita,
  NOVA: nova,
  TON: ton,
  NEXUS: nexus,
  FORGE: forge,
  ARCH: arch,
  VOLT: volt,
  MOTOR: motor,
  MESH: mesh,
  INFRA: infra,
  PLAT: plat,
  XAAS: xaas,
  BRAIN: brain,
};

export async function route(command: AgentCommand): Promise<unknown> {
  const handler = handlers[command.agentId];
  if (!handler) {
    throw new Error(`No handler registered for agentId "${command.agentId}"`);
  }
  return handler(command);
}
