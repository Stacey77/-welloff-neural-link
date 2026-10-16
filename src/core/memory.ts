import type { AgentId, AgentResult } from '../types/index.js';

const MAX_ENTRIES = 50;

const store = new Map<AgentId, AgentResult[]>();

export function get(agentId: AgentId): AgentResult[] {
  return store.get(agentId) ?? [];
}

export function push(result: AgentResult): void {
  const existing = store.get(result.agentId) ?? [];
  existing.push(result);
  if (existing.length > MAX_ENTRIES) {
    existing.splice(0, existing.length - MAX_ENTRIES);
  }
  store.set(result.agentId, existing);
}

export function summary(): Record<AgentId, { count: number; lastStatus: string | null }> {
  const agents: AgentId[] = ['ARIA', 'DEVX', 'TERRA', 'CAPITA', 'NOVA', 'TON'];
  const out = {} as Record<AgentId, { count: number; lastStatus: string | null }>;

  for (const id of agents) {
    const entries = store.get(id) ?? [];
    out[id] = {
      count: entries.length,
      lastStatus: entries.length > 0 ? entries[entries.length - 1].status : null,
    };
  }

  return out;
}
