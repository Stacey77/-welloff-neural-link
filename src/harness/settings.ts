import { join } from 'path';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';

export interface HarnessConfig {
  maxSteps: number;
  maxTokens: number;
  maxCostUsd: number;
  toolTimeoutMs: number;
  loopLimit: number;
  validateToolInputs: boolean;
  contextBudgetTokens: number;
  compactAt: number;
  toolResultMaxChars: number;
}

export const HARNESS_AGENTS = ['TON', 'BRAIN', 'IDE'] as const;
export type HarnessAgent = (typeof HARNESS_AGENTS)[number];

const DEFAULTS: Record<HarnessAgent, HarnessConfig> = {
  TON: { maxSteps: 8, maxTokens: 200_000, maxCostUsd: 1, toolTimeoutMs: 30_000, loopLimit: 3, validateToolInputs: true, contextBudgetTokens: 120_000, compactAt: 0.8, toolResultMaxChars: 12_000 },
  BRAIN: { maxSteps: 10, maxTokens: 250_000, maxCostUsd: 1.5, toolTimeoutMs: 30_000, loopLimit: 3, validateToolInputs: true, contextBudgetTokens: 150_000, compactAt: 0.8, toolResultMaxChars: 12_000 },
  IDE: { maxSteps: 18, maxTokens: 600_000, maxCostUsd: 4, toolTimeoutMs: 120_000, loopLimit: 3, validateToolInputs: true, contextBudgetTokens: 400_000, compactAt: 0.75, toolResultMaxChars: 60_000 },
};

const FILE = join(DATA_DIR, 'harness', 'settings.json');
let saved = readJson<Partial<Record<HarnessAgent, Partial<HarnessConfig>>>>(FILE, {});

export function harnessConfig(agent: string): HarnessConfig {
  const base = DEFAULTS[(HARNESS_AGENTS as readonly string[]).includes(agent) ? (agent as HarnessAgent) : 'TON'];
  return { ...base, ...(saved[agent as HarnessAgent] ?? {}) };
}

export function allHarnessConfigs() {
  return Object.fromEntries(HARNESS_AGENTS.map((a) => [a, harnessConfig(a)]));
}

const LIMITS: Record<keyof HarnessConfig, [number, number] | 'bool'> = {
  maxSteps: [1, 100], maxTokens: [1_000, 5_000_000], maxCostUsd: [0.01, 100], toolTimeoutMs: [1_000, 600_000], loopLimit: [1, 20],
  validateToolInputs: 'bool', contextBudgetTokens: [4_000, 2_000_000], compactAt: [0.3, 0.95], toolResultMaxChars: [500, 500_000],
};

export function updateHarness(agent: string, patch: Partial<HarnessConfig>): HarnessConfig {
  if (!(HARNESS_AGENTS as readonly string[]).includes(agent)) throw new Error(`agent must be one of ${HARNESS_AGENTS.join(', ')}`);
  const clean: Partial<HarnessConfig> = {};
  for (const [k, v] of Object.entries(patch) as [keyof HarnessConfig, unknown][]) {
    const lim = LIMITS[k];
    if (!lim) throw new Error(`Unknown setting ${k}`);
    if (lim === 'bool') { (clean as Record<string, unknown>)[k] = Boolean(v); continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < lim[0] || n > lim[1]) throw new Error(`${k} must be between ${lim[0]} and ${lim[1]}`);
    (clean as Record<string, unknown>)[k] = k === 'compactAt' || k === 'maxCostUsd' ? n : Math.round(n);
  }
  saved = { ...saved, [agent]: { ...(saved[agent as HarnessAgent] ?? {}), ...clean } };
  writeJson(FILE, saved);
  return harnessConfig(agent);
}
