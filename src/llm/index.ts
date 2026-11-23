import { PROVIDERS, getProvider, isConfigured, modelInfo, probeLocal, splitSpec, type Tier } from './catalog.js';
import { callAnthropic, callOpenAiCompat, listRemoteModels, ProviderError, type ChatMessage, type ChatRequest, type StopReason, type ToolCall } from './adapters.js';
import { getSettings, saveDiscovered, type Assignable, type Policy } from './settings.js';
import { recordTokenUsage } from '../observability/metrics.js';
import { traced } from '../integrations/langsmith.js';

export type { ChatMessage, ToolSpec, ToolCall, ToolResult } from './adapters.js';

export type TaskType = 'code' | 'reasoning' | 'creative' | 'quick' | 'general';

export interface RouteDecision {
  spec: string;
  chain: string[];
  taskType: TaskType;
  policy: Policy;
  tier: Tier;
  reason: string;
  assigned?: boolean;
}

export interface Attempt { spec: string; ok: boolean; error?: string; latencyMs: number }

export interface ChatResult {
  spec: string;
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage: { input: number; output: number };
  costUsd: number | null;
  latencyMs: number;
  attempts: Attempt[];
  assistant: ChatMessage;
}

/* ── Routing ── */

export function classify(prompt: string): TaskType {
  const p = prompt.toLowerCase();
  if (/\b(code|function|typescript|javascript|python|refactor|bug|stack trace|compile|regex|sql|api|endpoint|unit test|\.ts\b|\.py\b)/.test(p)) return 'code';
  if (/\b(prove|analy[sz]e|plan|strategy|compare|why|trade-?off|evaluate|diagnos|reason|step by step|architecture)/.test(p)) return 'reasoning';
  if (/\b(write|story|poem|slogan|ad copy|caption|tweet|post|creative|brainstorm|name ideas)/.test(p)) return 'creative';
  if (p.length < 120 && /^(what|who|when|where|is|are|define|translate|convert|list)\b/.test(p)) return 'quick';
  return 'general';
}

function tierFor(policy: Policy, task: TaskType): Tier {
  switch (policy) {
    case 'quality': return 'frontier';
    case 'speed': return 'fast';
    case 'economy': return task === 'code' || task === 'reasoning' ? 'balanced' : 'fast';
    default: return task === 'code' || task === 'reasoning' ? 'frontier' : task === 'quick' ? 'fast' : 'balanced';
  }
}

const TIER_ORDER: Tier[] = ['frontier', 'balanced', 'fast'];

export function availableProviders(): string[] {
  const s = getSettings();
  return s.providerOrder.filter((id) => !s.disabled.includes(id)).filter((id) => { const p = getProvider(id); return p && isConfigured(p); });
}

export function availableModels(): string[] {
  return availableProviders().flatMap((pid) => getProvider(pid)!.models.map((m) => `${pid}:${m.id}`));
}

function chainFor(tier: Tier, exclude: string[] = []): string[] {
  const providers = availableProviders();
  const tiers = [tier, ...TIER_ORDER.filter((t) => t !== tier)];
  const out: string[] = [];
  for (const t of tiers) {
    for (const pid of providers) {
      const m = getProvider(pid)!.models.find((x) => x.tier === t && !x.discovered) ?? getProvider(pid)!.models.find((x) => x.tier === t);
      if (m) out.push(`${pid}:${m.id}`);
    }
  }
  return [...new Set(out)].filter((s) => !exclude.includes(s));
}

export function route(prompt: string, opts: { policy?: Policy } = {}): RouteDecision {
  const policy = opts.policy ?? getSettings().policy;
  const taskType = classify(prompt);
  const tier = tierFor(policy, taskType);
  const chain = chainFor(tier);
  if (!chain.length) {
    throw new ProviderError('No LLM provider is configured. Add a key such as ANTHROPIC_API_KEY or OPENAI_API_KEY under Environment, or start Ollama locally.');
  }
  const spec = chain[0];
  const picked = modelInfo(spec);
  return {
    spec,
    chain,
    taskType,
    policy,
    tier,
    reason: `${taskType} task under the ${policy} policy calls for a ${tier} model; ${picked?.label ?? spec} is the first configured one${picked?.tier !== tier ? ` (no ${tier} model is configured, so it uses the next tier)` : ''}. Fallbacks: ${chain.slice(1, 4).join(', ') || 'none'}.`,
  };
}

export function resolveFor(agent: Assignable, hint: string): RouteDecision {
  const assigned = getSettings().assignments[agent];
  if (assigned && assigned !== 'auto') {
    const { provider } = splitSpec(assigned);
    const p = getProvider(provider);
    if (!p) throw new ProviderError(`Unknown provider in assignment for ${agent}: ${assigned}`);
    const info = modelInfo(assigned);
    const fallback = chainFor(info?.tier ?? 'balanced', [assigned]);
    return {
      spec: assigned,
      chain: [assigned, ...fallback],
      taskType: classify(hint),
      policy: getSettings().policy,
      tier: info?.tier ?? 'balanced',
      reason: `${agent} is assigned to ${assigned}${isConfigured(p) ? '' : ' (its provider is not configured, so the fallback chain will be used)'}.`,
      assigned: true,
    };
  }
  return route(hint);
}

/* ── Stats ── */

interface ModelStats { calls: number; failures: number; input: number; output: number; costUsd: number; latencies: number[]; lastError?: string }
const stats = new Map<string, ModelStats>();

function stat(spec: string): ModelStats {
  let s = stats.get(spec);
  if (!s) { s = { calls: 0, failures: 0, input: 0, output: 0, costUsd: 0, latencies: [] }; stats.set(spec, s); }
  return s;
}

function costOf(spec: string, usage: { input: number; output: number }): number | null {
  const price = modelInfo(spec)?.price;
  return price ? (usage.input * price.input + usage.output * price.output) / 1_000_000 : null;
}

export function llmStats() {
  return [...stats.entries()].map(([spec, s]) => {
    const sorted = [...s.latencies].sort((a, b) => a - b);
    return { spec, calls: s.calls, failures: s.failures, inputTokens: s.input, outputTokens: s.output, costUsd: s.costUsd, p50LatencyMs: sorted[Math.floor(sorted.length / 2)] ?? null, lastError: s.lastError };
  }).sort((a, b) => b.calls - a.calls);
}

/* ── Calls ── */

async function callOnce(spec: string, req: ChatRequest) {
  const { provider, model } = splitSpec(spec);
  const p = getProvider(provider);
  if (!p) throw new ProviderError(`Unknown provider ${provider}`);
  if (p.local && !(await probeLocal(p))) throw new ProviderError(`${p.label} is not running at ${p.baseUrl}`);
  if (!p.local && !isConfigured(p)) throw new ProviderError(`${p.label} has no API key. Add ${p.keyEnv} under Environment.`);
  return p.kind === 'anthropic' ? callAnthropic(spec, model, req) : callOpenAiCompat(p, model, req);
}

export async function chat(chain: string[], req: ChatRequest, meta: { agent?: string } = {}): Promise<ChatResult> {
  const attempts: Attempt[] = [];
  for (const spec of chain) {
    const started = Date.now();
    try {
      const { provider, model } = splitSpec(spec);
      const r = await traced(spec, 'llm', { messages: traceMessages(req) }, () => callOnce(spec, req), {
        metadata: { ls_provider: provider, ls_model_name: model, agent: meta.agent, tools: req.tools?.map((t) => t.name) },
        outputs: (x) => ({ text: x.text, tool_calls: x.toolCalls, stop: x.stop, usage_metadata: { input_tokens: x.usage.input, output_tokens: x.usage.output, total_tokens: x.usage.input + x.usage.output } }),
      });
      if (r.stop === 'refusal') throw new ProviderError(`${spec} declined the request`);
      const latencyMs = Date.now() - started;
      attempts.push({ spec, ok: true, latencyMs });
      const s = stat(spec);
      const cost = costOf(spec, r.usage);
      s.calls++; s.input += r.usage.input; s.output += r.usage.output; s.costUsd += cost ?? 0;
      s.latencies.push(latencyMs); if (s.latencies.length > 100) s.latencies.shift();
      if (meta.agent) recordTokenUsage(meta.agent, { input_tokens: r.usage.input, output_tokens: r.usage.output });
      return {
        spec, text: r.text, toolCalls: r.toolCalls, stop: r.stop, usage: r.usage, costUsd: cost, latencyMs, attempts,
        assistant: { role: 'assistant', text: r.text, toolCalls: r.toolCalls, raw: { spec, content: r.raw } },
      };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || req.signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ spec, ok: false, error: msg, latencyMs: Date.now() - started });
      const s = stat(spec); s.failures++; s.lastError = msg;
    }
  }
  const detail = attempts.map((a) => `${a.spec}: ${a.error}`).join(' · ');
  if (!chain.length) throw new ProviderError('No model is available. Configure a provider under Models.');
  throw new ProviderError(chain.length === 1 ? `${attempts[0].spec} failed: ${attempts[0].error}` : `Every model in the chain failed. ${detail}`);
}

function traceMessages(req: ChatRequest) {
  const out: { role: string; content: string }[] = req.system ? [{ role: 'system', content: req.system }] : [];
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: m.text + (m.toolCalls.length ? `\n[tool calls: ${m.toolCalls.map((c) => c.name).join(', ')}]` : '') });
    else out.push(...m.results.map((r) => ({ role: 'tool', content: `${r.name}: ${r.content.slice(0, 2_000)}` })));
  }
  return out;
}

// Keeps a multi-turn tool loop on the model that answered, falling back only when it fails.
export class LlmSession {
  chain: string[];
  readonly decision: RouteDecision;
  readonly used = new Set<string>();

  constructor(readonly agent: Assignable, hint: string, override?: string) {
    if (override && override !== 'auto') {
      const info = modelInfo(override);
      this.decision = { spec: override, chain: [override, ...chainFor(info?.tier ?? 'balanced', [override])], taskType: classify(hint), policy: getSettings().policy, tier: info?.tier ?? 'balanced', reason: `Chosen for this run: ${override}.`, assigned: true };
    } else {
      this.decision = resolveFor(agent, hint);
    }
    this.chain = this.decision.chain;
  }

  async turn(req: ChatRequest): Promise<ChatResult> {
    const r = await chat(this.chain, req, { agent: this.agent });
    this.used.add(r.spec);
    this.chain = [r.spec, ...this.chain.filter((s) => s !== r.spec)];
    return r;
  }
}

export async function ask(agent: Assignable, prompt: string, opts: { system?: string; maxTokens?: number; model?: string } = {}): Promise<ChatResult & { decision: RouteDecision }> {
  const session = new LlmSession(agent, prompt, opts.model);
  const r = await session.turn({ system: opts.system, maxTokens: opts.maxTokens, messages: [{ role: 'user', content: prompt }] });
  return { ...r, decision: session.decision };
}

/* ── Multi-model: compare and council ── */

export interface CompareEntry { spec: string; ok: boolean; text?: string; error?: string; latencyMs: number; usage?: { input: number; output: number }; costUsd?: number | null }

export async function compare(prompt: string, specs: string[], system?: string): Promise<CompareEntry[]> {
  if (!specs.length) throw new Error('Pick at least one model.');
  if (specs.length > 6) throw new Error('Compare at most 6 models at once.');
  return Promise.all(specs.map(async (spec): Promise<CompareEntry> => {
    const started = Date.now();
    try {
      const r = await chat([spec], { system, maxTokens: 4_000, messages: [{ role: 'user', content: prompt }] }, { agent: 'MAESTRO' });
      return { spec, ok: true, text: r.text, latencyMs: r.latencyMs, usage: r.usage, costUsd: r.costUsd };
    } catch (err) {
      return { spec, ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
    }
  }));
}

export interface Verdict {
  judge: string;
  scores: { spec: string; score: number; strengths: string; weaknesses: string }[];
  winner: string | null;
  synthesis: string;
  raw?: string;
}

const LABELS = 'ABCDEF';

export async function council(prompt: string, specs: string[], judgeSpec?: string): Promise<{ answers: CompareEntry[]; verdict: Verdict | null; judgeError?: string }> {
  const answers = await compare(prompt, specs);
  const ok = answers.filter((a) => a.ok && a.text);
  if (!ok.length) return { answers, verdict: null, judgeError: 'No model produced an answer to judge.' };
  const judgePrompt = [
    'You are the judge on a council of AI models. Several models answered the same request. Their identities are hidden.',
    'Score each answer from 1 to 10 for correctness, completeness and usefulness, then write the best possible final answer, combining the strongest parts.',
    'Reply with JSON only, in this shape:',
    '{"scores":[{"label":"A","score":8,"strengths":"...","weaknesses":"..."}],"winner":"A","synthesis":"the final answer"}',
    '',
    `REQUEST:\n${prompt}`,
    '',
    ...ok.map((a, i) => `ANSWER ${LABELS[i]}:\n${a.text}`),
  ].join('\n');
  let session: LlmSession;
  try {
    session = new LlmSession('JUDGE', 'analyze and evaluate answers', judgeSpec);
  } catch (err) {
    return { answers, verdict: null, judgeError: err instanceof Error ? err.message : String(err) };
  }
  try {
    const r = await session.turn({ maxTokens: 8_000, messages: [{ role: 'user', content: judgePrompt }] });
    const match = r.text.match(/\{[\s\S]*\}/);
    let parsed: any = null;
    try { parsed = match ? JSON.parse(match[0]) : null; } catch { parsed = null; }
    const bySpec = (label: string) => ok[LABELS.indexOf(String(label).trim().toUpperCase())]?.spec ?? null;
    const verdict: Verdict = parsed
      ? {
        judge: r.spec,
        scores: (parsed.scores ?? []).map((s: any) => ({ spec: bySpec(s.label) ?? String(s.label), score: Number(s.score) || 0, strengths: String(s.strengths ?? ''), weaknesses: String(s.weaknesses ?? '') })),
        winner: bySpec(parsed.winner),
        synthesis: String(parsed.synthesis ?? ''),
      }
      : { judge: r.spec, scores: [], winner: null, synthesis: r.text, raw: r.text };
    return { answers, verdict };
  } catch (err) {
    return { answers, verdict: null, judgeError: err instanceof Error ? err.message : String(err) };
  }
}

/* ── Overview ── */

export async function describe() {
  await Promise.all(PROVIDERS.filter((p) => p.local).map((p) => probeLocal(p)));
  const s = getSettings();
  return {
    providers: s.providerOrder.map((id) => getProvider(id)!).map((p) => ({
      id: p.id, label: p.label, kind: p.kind, keyEnv: p.keyEnv ?? null, local: Boolean(p.local), docs: p.docs,
      configured: isConfigured(p), disabled: s.disabled.includes(p.id),
      models: p.models.map((m) => ({ ...m, spec: `${p.id}:${m.id}` })),
    })),
    settings: { policy: s.policy, providerOrder: s.providerOrder, disabled: s.disabled, assignments: s.assignments },
    available: availableModels(),
    stats: llmStats(),
  };
}

export async function discover(providerId: string) {
  const p = getProvider(providerId);
  if (!p) throw new Error('Unknown provider');
  const ids = await listRemoteModels(p);
  const chatLike = ids.filter((id) => !/(embed|whisper|tts|dall-e|image|moderation|audio|transcribe|rerank|guard)/i.test(id));
  const added = saveDiscovered(providerId, chatLike);
  return { provider: providerId, found: chatLike.length, added: added.map((m) => m.id) };
}
