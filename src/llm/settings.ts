import { join } from 'path';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';
import { PROVIDERS, splitSpec, type ModelInfo, type Tier } from './catalog.js';

export type Policy = 'quality' | 'balanced' | 'economy' | 'speed';

// Agents whose model can be assigned. 'auto' lets MAESTRO route per request.
export const ASSIGNABLE = ['TON', 'BRAIN', 'NATURA', 'GENESIS', 'IDE', 'JUDGE', 'AXIOM', 'EVE', 'SECURITY', 'SUBAGENT'] as const;
export type Assignable = (typeof ASSIGNABLE)[number];

export interface LlmSettings {
  policy: Policy;
  providerOrder: string[];
  disabled: string[];
  assignments: Record<Assignable, string>;
  discovered: Record<string, ModelInfo[]>;
}

const FILE = join(DATA_DIR, 'llm-settings.json');
const POLICIES: Policy[] = ['quality', 'balanced', 'economy', 'speed'];

function defaults(): LlmSettings {
  return {
    policy: (POLICIES as string[]).includes(process.env.LLM_POLICY ?? '') ? (process.env.LLM_POLICY as Policy) : 'balanced',
    providerOrder: PROVIDERS.map((p) => p.id),
    disabled: [],
    assignments: { TON: 'auto', BRAIN: 'auto', NATURA: 'auto', GENESIS: 'auto', IDE: process.env.IDE_AGENT_MODEL ? `anthropic:${process.env.IDE_AGENT_MODEL}` : 'auto', JUDGE: 'auto', AXIOM: 'auto', EVE: 'auto', SECURITY: 'auto', SUBAGENT: 'auto' },
    discovered: {},
  };
}

let settings: LlmSettings = { ...defaults(), ...readJson<Partial<LlmSettings>>(FILE, {}) };
settings.assignments = { ...defaults().assignments, ...settings.assignments };
applyDiscovered();

function applyDiscovered(): void {
  for (const [pid, models] of Object.entries(settings.discovered)) {
    const p = PROVIDERS.find((x) => x.id === pid);
    if (!p) continue;
    for (const m of models) if (!p.models.some((x) => x.id === m.id)) p.models.push({ ...m, discovered: true });
  }
}

export function getSettings(): LlmSettings {
  return settings;
}

export function updateSettings(patch: Partial<Pick<LlmSettings, 'policy' | 'providerOrder' | 'disabled' | 'assignments'>>): LlmSettings {
  const next = { ...settings };
  if (patch.policy !== undefined) {
    if (!POLICIES.includes(patch.policy)) throw new Error(`policy must be one of ${POLICIES.join(', ')}`);
    next.policy = patch.policy;
  }
  if (patch.providerOrder) {
    const known = PROVIDERS.map((p) => p.id);
    next.providerOrder = [...patch.providerOrder.filter((id) => known.includes(id)), ...known.filter((id) => !patch.providerOrder!.includes(id))];
  }
  if (patch.disabled) next.disabled = patch.disabled.filter((id) => PROVIDERS.some((p) => p.id === id));
  if (patch.assignments) {
    for (const [agent, spec] of Object.entries(patch.assignments)) {
      if (!(ASSIGNABLE as readonly string[]).includes(agent)) throw new Error(`Unknown agent ${agent}`);
      if (spec !== 'auto') splitSpec(spec);
      next.assignments = { ...next.assignments, [agent]: spec };
    }
  }
  settings = next;
  writeJson(FILE, settings);
  return settings;
}

export function saveDiscovered(providerId: string, ids: string[]): ModelInfo[] {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) throw new Error('Unknown provider');
  const added: ModelInfo[] = [];
  for (const id of ids) {
    if (p.models.some((m) => m.id === id)) continue;
    const m: ModelInfo = { id, label: id, tier: guessTier(id), discovered: true };
    p.models.push(m);
    added.push(m);
  }
  settings.discovered = { ...settings.discovered, [providerId]: p.models.filter((m) => m.discovered).map(({ discovered, ...m }) => m) };
  writeJson(FILE, settings);
  return added;
}

function guessTier(id: string): Tier {
  if (/(mini|nano|flash|lite|haiku|small|8b|7b|instant)/i.test(id)) return 'fast';
  if (/(opus|pro|large|ultra|-4$|grok-4|gpt-5$|reasoner)/i.test(id)) return 'frontier';
  return 'balanced';
}
