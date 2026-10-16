import { z } from 'zod';

export type AgentId =
  | 'ARIA' | 'DEVX' | 'TERRA' | 'CAPITA' | 'NOVA' | 'TON'
  | 'NEXUS' | 'FORGE' | 'ARCH' | 'VOLT' | 'MOTOR' | 'MESH'
  | 'INFRA' | 'PLAT' | 'XAAS' | 'BRAIN' | 'GENESIS' | 'NATURA';

export const AgentIdSchema = z.enum([
  'ARIA', 'DEVX', 'TERRA', 'CAPITA', 'NOVA', 'TON',
  'NEXUS', 'FORGE', 'ARCH', 'VOLT', 'MOTOR', 'MESH',
  'INFRA', 'PLAT', 'XAAS', 'BRAIN', 'GENESIS', 'NATURA',
]);

export interface AgentCommand {
  id: string;
  agentId: AgentId;
  command: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

export const AgentCommandSchema = z.object({
  id: z.string(),
  agentId: AgentIdSchema,
  command: z.string(),
  params: z.record(z.unknown()).optional(),
  timestamp: z.number(),
});

export interface AgentResult {
  commandId: string;
  agentId: AgentId;
  status: 'success' | 'error';
  result?: unknown;
  error?: string;
  latencyMs: number;
}

export type NeuralEvent =
  | { type: 'command'; payload: AgentCommand }
  | { type: 'result'; payload: AgentResult }
  | { type: 'heartbeat'; timestamp: number }
  | { type: 'broadcast'; message: string; from: AgentId };

export const DispatchRequestSchema = z.object({
  agentId: AgentIdSchema,
  command: z.string(),
  params: z.record(z.unknown()).optional(),
});

export const TonRequestSchema = z.object({
  message: z.string().min(1),
});

export const McpCallSchema = z.object({
  tool: z.string(),
  params: z.record(z.unknown()).optional(),
});
