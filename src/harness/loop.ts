import { createHash, randomUUID } from 'crypto';
import { LlmSession, chat, route, type ChatMessage, type ToolSpec, type ToolCall, type ChatResult } from '../llm/index.js';
import { harnessConfig, type HarnessConfig } from './settings.js';
import { clip, composition, estimateTokens, transcriptForSummary, type Composition } from './context.js';

export type StopReason = 'end' | 'max_steps' | 'budget_tokens' | 'budget_cost' | 'loop' | 'cancelled' | 'error';

export interface ToolTrace { name: string; ok: boolean; ms: number; clipped: number; invalid?: string; repeated?: number }
export interface StepTrace { i: number; model: string; ms: number; input: number; output: number; context: Composition; tools: ToolTrace[]; fallbacks: string[]; compacted?: { before: number; after: number; model: string } }
export interface RunTrace {
  id: string; agent: string; task: string; startedAt: number; endedAt?: number; stop?: StopReason; error?: string;
  config: HarnessConfig; steps: StepTrace[]; tokens: { input: number; output: number }; costUsd: number; compactions: number;
}

const RUNS: RunTrace[] = [];
const MAX_RUNS = 200;
export function recentRuns(limit = 50) { return RUNS.slice(-limit).reverse(); }
export function getRun(id: string) { return RUNS.find((r) => r.id === id); }

export interface LoopHooks {
  onModel?: (res: ChatResult, step: number) => void;
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (call: ToolCall, output: string, ok: boolean) => void;
  onCompact?: (summary: string) => void;
}

export interface LoopOptions {
  agent: string;
  session: LlmSession;
  system: string;
  tools: ToolSpec[];
  messages: ChatMessage[];
  execute: (call: ToolCall) => Promise<string>;
  task?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  hooks?: LoopHooks;
  config?: Partial<HarnessConfig>;
}

export interface LoopResult { text: string; stop: StopReason; steps: number; runId: string; models: string[]; tokens: { input: number; output: number }; costUsd: number }

/* Minimal JSON-schema check for tool inputs: required keys, primitive types, enums. */
export function validateInput(schema: Record<string, unknown> | undefined, input: Record<string, unknown>): string | null {
  if (!schema || schema.type !== 'object') return null;
  const props = (schema.properties ?? {}) as Record<string, { type?: string | string[]; enum?: unknown[] }>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (input[key] === undefined || input[key] === null || input[key] === '') return `missing required field "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const p = props[key];
    if (!p || value === undefined || value === null) continue;
    const types = Array.isArray(p.type) ? p.type : p.type ? [p.type] : [];
    const actual = Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
    const ok = !types.length || types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) return `field "${key}" should be ${types.join(' or ')}, got ${actual}`;
    if (p.enum && !p.enum.includes(value)) return `field "${key}" must be one of ${p.enum.map(String).join(', ')}`;
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Compaction starts a fresh transcript from a summary instead of editing history in place,
// so no provider ever sees a rewritten conversation (Claude requires its turns unchanged).
async function compact(agent: string, task: string, messages: ChatMessage[], signal?: AbortSignal): Promise<{ messages: ChatMessage[]; summary: string; model: string }> {
  const chain = route('summarize progress', { policy: 'speed' }).chain;
  const r = await chat(chain, {
    maxTokens: 2_000,
    signal,
    messages: [{
      role: 'user',
      content: `Summarize this agent run so the agent can continue without the full transcript. Keep: the goal, decisions made, facts and IDs learned from tools, what is done, what remains, and any errors to avoid repeating. Be concise; use bullet points.\n\nTRANSCRIPT:\n${transcriptForSummary(messages)}`,
    }],
  }, { agent });
  return {
    summary: r.text,
    model: r.spec,
    messages: [{ role: 'user', content: `${task}\n\n[Context was compacted to stay within budget. Progress so far:]\n${r.text}\n\nContinue from here.` }],
  };
}

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const cfg = { ...harnessConfig(o.agent), ...o.config };
  const task = o.task ?? (o.messages.find((m) => m.role === 'user') as { content: string } | undefined)?.content ?? '';
  const run: RunTrace = { id: `run_${randomUUID().slice(0, 8)}`, agent: o.agent, task: task.slice(0, 300), startedAt: Date.now(), config: cfg, steps: [], tokens: { input: 0, output: 0 }, costUsd: 0, compactions: 0 };
  RUNS.push(run);
  if (RUNS.length > MAX_RUNS) RUNS.splice(0, RUNS.length - MAX_RUNS);

  let messages = [...o.messages];
  const seen = new Map<string, number>();
  const schemas = new Map(o.tools.map((t) => [t.name, t.input_schema]));
  let text = '';
  const finish = (stop: StopReason, msg?: string): LoopResult => {
    run.stop = stop;
    run.endedAt = Date.now();
    if (msg) run.error = msg;
    return { text, stop, steps: run.steps.length, runId: run.id, models: [...o.session.used], tokens: run.tokens, costUsd: run.costUsd };
  };

  try {
    for (let i = 1; i <= cfg.maxSteps; i++) {
      if (o.signal?.aborted) return finish('cancelled');
      let compacted: StepTrace['compacted'];
      const before = composition(o.system, o.tools, messages);
      if (before.total > cfg.contextBudgetTokens * cfg.compactAt && messages.length > 2) {
        const c = await compact(o.agent, task, messages, o.signal);
        messages = c.messages;
        run.compactions++;
        compacted = { before: before.total, after: composition(o.system, o.tools, messages).total, model: c.model };
        o.hooks?.onCompact?.(c.summary);
      }
      const ctx = composition(o.system, o.tools, messages);
      const started = Date.now();
      const res = await o.session.turn({ system: o.system, tools: o.tools, messages, maxTokens: o.maxTokens ?? 16_000, signal: o.signal });
      run.tokens.input += res.usage.input;
      run.tokens.output += res.usage.output;
      run.costUsd += res.costUsd ?? 0;
      const step: StepTrace = { i, model: res.spec, ms: Date.now() - started, input: res.usage.input, output: res.usage.output, context: ctx, tools: [], fallbacks: res.attempts.filter((a) => !a.ok).map((a) => `${a.spec}: ${a.error}`), compacted };
      run.steps.push(step);
      o.hooks?.onModel?.(res, i);
      text = res.text;

      if (res.stop !== 'tool_use' || !res.toolCalls.length) return finish('end');
      if (run.tokens.input + run.tokens.output >= cfg.maxTokens) { text = text || `Stopped: the run used its ${cfg.maxTokens.toLocaleString()}-token budget.`; return finish('budget_tokens'); }
      if (run.costUsd >= cfg.maxCostUsd) { text = text || `Stopped: the run reached its $${cfg.maxCostUsd} cost budget.`; return finish('budget_cost'); }

      messages.push(res.assistant);
      let loopStop = false;
      const results = await Promise.all(res.toolCalls.map(async (call) => {
        const t0 = Date.now();
        const key = createHash('sha1').update(`${call.name}\u0000${JSON.stringify(call.input)}`).digest('hex');
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        const trace: ToolTrace = { name: call.name, ok: false, ms: 0, clipped: 0 };
        step.tools.push(trace);
        if (count > cfg.loopLimit) {
          trace.repeated = count;
          if (count > cfg.loopLimit + 1) loopStop = true;
          return { id: call.id, name: call.name, content: `You have called ${call.name} with identical input ${count} times. It will return the same result. Change your approach or finish with what you have.`, isError: true };
        }
        const invalid = cfg.validateToolInputs ? validateInput(schemas.get(call.name), call.input) : null;
        if (invalid) {
          trace.invalid = invalid;
          return { id: call.id, name: call.name, content: `Invalid input for ${call.name}: ${invalid}. Fix the arguments and call it again.`, isError: true };
        }
        o.hooks?.onToolStart?.(call);
        try {
          const out = await withTimeout(o.execute(call), cfg.toolTimeoutMs, call.name);
          const c = clip(out, cfg.toolResultMaxChars);
          trace.ok = true; trace.ms = Date.now() - t0; trace.clipped = c.clipped;
          o.hooks?.onToolEnd?.(call, c.text, true);
          return { id: call.id, name: call.name, content: c.text };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          trace.ms = Date.now() - t0;
          o.hooks?.onToolEnd?.(call, msg, false);
          return { id: call.id, name: call.name, content: msg, isError: true };
        }
      }));
      messages.push({ role: 'tool', results });
      if (loopStop) { text = text || 'Stopped: the agent kept repeating the same tool call.'; return finish('loop'); }
    }
    text = text || `Stopped after ${cfg.maxSteps} steps.`;
    return finish('max_steps');
  } catch (err) {
    if (o.signal?.aborted) return finish('cancelled');
    const msg = err instanceof Error ? err.message : String(err);
    finish('error', msg);
    throw err;
  }
}

export function contextReport() {
  const runs = recentRuns(200);
  const steps = runs.flatMap((r) => r.steps);
  const avg = (k: keyof Composition) => (steps.length ? Math.round(steps.reduce((t, s) => t + s.context[k], 0) / steps.length) : 0);
  return {
    runs: runs.length,
    steps: steps.length,
    compactions: runs.reduce((t, r) => t + r.compactions, 0),
    clippedResults: steps.reduce((t, s) => t + s.tools.filter((x) => x.clipped).length, 0),
    invalidCalls: steps.reduce((t, s) => t + s.tools.filter((x) => x.invalid).length, 0),
    repeatedCalls: steps.reduce((t, s) => t + s.tools.filter((x) => x.repeated).length, 0),
    averageContext: { system: avg('system'), tools: avg('tools'), user: avg('user'), assistant: avg('assistant'), toolResults: avg('toolResults'), total: avg('total') },
    estimated: true,
  };
}

export { estimateTokens };
