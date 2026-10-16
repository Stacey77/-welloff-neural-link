interface AgentMetrics {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  totalCostUsd: number;
  latencies: number[];  // rolling last 100ms values
}

interface SystemMetrics {
  agents: Record<string, AgentMetrics>;
  a2aMessages: number;
  mcpCalls: number;
  startedAt: number;
  totalCostUsd: number;
}

const store: SystemMetrics = {
  agents: {},
  a2aMessages: 0,
  mcpCalls: 0,
  startedAt: Date.now(),
  totalCostUsd: 0,
};

function getOrCreate(agentId: string): AgentMetrics {
  if (!store.agents[agentId]) {
    store.agents[agentId] = { inputTokens: 0, outputTokens: 0, calls: 0, totalCostUsd: 0, latencies: [] };
  }
  return store.agents[agentId];
}

function computePercentile(arr: number[], pct: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * pct) - 1);
  return sorted[idx];
}

export function recordTokenUsage(agentId: string, usage: { input_tokens?: number; output_tokens?: number } | null | undefined): void {
  if (!usage) return;
  const m = getOrCreate(agentId);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  m.inputTokens += input;
  m.outputTokens += output;
  m.calls++;
  // Sonnet 4 pricing: $3/M input, $15/M output
  const cost = (input * 3 + output * 15) / 1_000_000;
  m.totalCostUsd += cost;
  store.totalCostUsd += cost;
}

export function recordLatency(agentId: string, ms: number): void {
  const m = getOrCreate(agentId);
  m.latencies.push(ms);
  if (m.latencies.length > 100) m.latencies.splice(0, m.latencies.length - 100);
}

export function incrementA2A(): void {
  store.a2aMessages++;
}

export function incrementMcp(): void {
  store.mcpCalls++;
}

export function getMetrics() {
  const uptimeMs = Date.now() - store.startedAt;
  return {
    uptimeMs,
    uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
    totalCostUsd: store.totalCostUsd,
    a2aMessages: store.a2aMessages,
    mcpCalls: store.mcpCalls,
    agents: Object.fromEntries(
      Object.entries(store.agents).map(([id, m]) => [id, {
        calls: m.calls,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        totalCostUsd: m.totalCostUsd,
        p50LatencyMs: computePercentile(m.latencies, 0.5),
        p95LatencyMs: computePercentile(m.latencies, 0.95),
      }])
    ),
  };
}

export function resetMetrics(): void {
  store.agents = {};
  store.a2aMessages = 0;
  store.mcpCalls = 0;
  store.totalCostUsd = 0;
}
