import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { baseUrlOf, envValue, type ProviderInfo } from './catalog.js';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

// Provider-neutral transcript. `raw` keeps a provider's own assistant content so it can be
// sent back unchanged to the same model (Claude's thinking blocks must not be edited or dropped).
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: { spec: string; content: unknown } }
  | { role: 'tool'; results: ToolResult[] };

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface AdapterResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage: { input: number; output: number };
  raw: unknown;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/* ── Anthropic (official SDK) ── */

function toAnthropicMessages(spec: string, messages: ChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (m.raw && m.raw.spec === spec) {
        out.push({ role: 'assistant', content: m.raw.content as MessageParam['content'] });
      } else {
        const content: any[] = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no output)' }] });
      }
    } else {
      out.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, is_error: r.isError })) });
    }
  }
  return out;
}

export async function callAnthropic(spec: string, model: string, req: ChatRequest): Promise<AdapterResult> {
  const key = envValue('ANTHROPIC_API_KEY');
  const client = new Anthropic(key ? { apiKey: key } : {});
  let res;
  try {
    res = await client.messages.create(
      {
        model,
        max_tokens: req.maxTokens ?? 16_000,
        ...(req.system ? { system: req.system } : {}),
        ...(req.tools?.length ? { tools: req.tools as unknown as Tool[] } : {}),
        messages: toAnthropicMessages(spec, req.messages),
      },
      { signal: req.signal },
    );
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw new ProviderError(err.message, err.status);
    throw err;
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
  const toolCalls = res.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => { const t = b as { id: string; name: string; input: unknown }; return { id: t.id, name: t.name, input: (t.input ?? {}) as Record<string, unknown> }; });
  const sr = String(res.stop_reason);
  const stop: StopReason = sr === 'tool_use' ? 'tool_use' : sr === 'end_turn' || sr === 'stop_sequence' ? 'end' : sr === 'max_tokens' ? 'max_tokens' : sr === 'refusal' ? 'refusal' : 'other';
  return { text, toolCalls, stop, usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 }, raw: res.content };
}

/* ── OpenAI-compatible chat completions (OpenAI, Gemini, xAI, Mistral, DeepSeek, Groq, OpenRouter, Ollama) ── */

function toOpenAiMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
    }
  }
  return out;
}

function parseArgs(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>;
  try { const v = JSON.parse(String(s || '{}')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export async function callOpenAiCompat(p: ProviderInfo, model: string, req: ChatRequest): Promise<AdapterResult> {
  const key = envValue(p.keyEnv);
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(req),
    [p.maxTokensField ?? 'max_tokens']: req.maxTokens ?? 8_000,
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrlOf(p)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ProviderError(`${p.label} is unreachable: ${(err as Error).message}`);
  }
  const textBody = await res.text();
  let json: any;
  try { json = JSON.parse(textBody); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? textBody.slice(0, 300);
    throw new ProviderError(`${p.label} ${res.status}: ${msg}`, res.status);
  }
  const choice = json?.choices?.[0];
  if (!choice) throw new ProviderError(`${p.label} returned no choices`);
  const msg = choice.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
    id: c.id || `call_${i}`,
    name: c.function?.name ?? '',
    input: parseArgs(c.function?.arguments),
  }));
  const fr = String(choice.finish_reason ?? '');
  const stop: StopReason = toolCalls.length || fr === 'tool_calls' ? 'tool_use' : fr === 'length' ? 'max_tokens' : fr === 'content_filter' ? 'refusal' : 'end';
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c: any) => c.text ?? '').join('') : '';
  return {
    text: text.trim(),
    toolCalls,
    stop,
    usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
    raw: msg,
  };
}

export async function listRemoteModels(p: ProviderInfo): Promise<string[]> {
  // The installed Anthropic SDK predates its Models API; the catalog already lists current Claude models.
  if (p.kind === 'anthropic') return p.models.map((m) => m.id);
  const key = envValue(p.keyEnv);
  const r = await fetch(`${baseUrlOf(p)}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new ProviderError(`${p.label} ${r.status} while listing models`, r.status);
  const j: any = await r.json();
  const list: any[] = j.data ?? j.models ?? [];
  return list.map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
}
