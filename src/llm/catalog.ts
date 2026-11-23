import { readEnvFile } from '../ide/env.js';

export type Tier = 'frontier' | 'balanced' | 'fast';
export type ProviderKind = 'anthropic' | 'openai-compat';

export interface ModelInfo {
  id: string;
  label: string;
  tier: Tier;
  // USD per million tokens; null where we do not track the provider's pricing.
  price?: { input: number; output: number } | null;
  discovered?: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  keyEnv?: string;
  baseUrlEnv?: string;
  docs: string;
  models: ModelInfo[];
  // OpenAI's newer models reject max_tokens in favour of max_completion_tokens.
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  local?: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic', label: 'Anthropic Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY',
    docs: 'console.anthropic.com',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'frontier', price: { input: 4, output: 20 } },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'balanced', price: { input: 2, output: 10 } },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'fast', price: { input: 0.1, output: 0.5 } },
    ],
  },
  {
    id: 'openai', label: 'OpenAI', kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL',
    docs: 'platform.openai.com', maxTokensField: 'max_completion_tokens',
    models: [
      { id: 'gpt-5', label: 'GPT-5', tier: 'frontier' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', tier: 'balanced' },
      { id: 'gpt-5-nano', label: 'GPT-5 nano', tier: 'fast' },
    ],
  },
  {
    id: 'google', label: 'Google Gemini', kind: 'openai-compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY',
    docs: 'aistudio.google.com',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'frontier' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'balanced' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'fast' },
    ],
  },
  {
    id: 'xai', label: 'xAI Grok', kind: 'openai-compat', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', docs: 'console.x.ai',
    models: [{ id: 'grok-4', label: 'Grok 4', tier: 'frontier' }],
  },
  {
    id: 'mistral', label: 'Mistral', kind: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', docs: 'console.mistral.ai',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large', tier: 'balanced' },
      { id: 'mistral-small-latest', label: 'Mistral Small', tier: 'fast' },
    ],
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', docs: 'platform.deepseek.com',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', tier: 'balanced' }],
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', docs: 'console.groq.com',
    models: [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)', tier: 'fast' }],
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', docs: 'openrouter.ai',
    models: [{ id: 'openrouter/auto', label: 'OpenRouter Auto', tier: 'balanced' }],
  },
  {
    id: 'ollama', label: 'Ollama (local)', kind: 'openai-compat', baseUrl: 'http://127.0.0.1:11434/v1', baseUrlEnv: 'OLLAMA_BASE_URL', docs: 'ollama.com',
    local: true,
    models: [{ id: 'llama3.1', label: 'Llama 3.1 (local)', tier: 'fast' }],
  },
];

const PLACEHOLDER = /^(your[_-]|sk-x+$|changeme|todo$)/i;

export function envValue(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const v = process.env[name] || readEnvFile()[name];
  return v && !PLACEHOLDER.test(v) ? v : undefined;
}

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function baseUrlOf(p: ProviderInfo): string {
  return (envValue(p.baseUrlEnv) ?? p.baseUrl).replace(/\/$/, '');
}

const localUp = new Map<string, { up: boolean; at: number }>();

export async function probeLocal(p: ProviderInfo): Promise<boolean> {
  const cached = localUp.get(p.id);
  if (cached && Date.now() - cached.at < 30_000) return cached.up;
  let up = false;
  try {
    const r = await fetch(`${baseUrlOf(p)}/models`, { signal: AbortSignal.timeout(800) });
    up = r.ok;
  } catch { up = false; }
  localUp.set(p.id, { up, at: Date.now() });
  return up;
}

export function isConfigured(p: ProviderInfo): boolean {
  if (p.local) return localUp.get(p.id)?.up ?? false;
  if (p.kind === 'anthropic') return Boolean(envValue('ANTHROPIC_API_KEY') || envValue('ANTHROPIC_AUTH_TOKEN') || process.env.ANTHROPIC_BASE_URL);
  return Boolean(envValue(p.keyEnv));
}

export function splitSpec(spec: string): { provider: string; model: string } {
  const i = spec.indexOf(':');
  if (i < 0) throw new Error(`Model "${spec}" must be written provider:model, e.g. anthropic:claude-opus-5-5`);
  return { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

export function modelInfo(spec: string): ModelInfo | undefined {
  const { provider, model } = splitSpec(spec);
  return getProvider(provider)?.models.find((m) => m.id === model);
}
