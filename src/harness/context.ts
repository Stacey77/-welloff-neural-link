import type { ChatMessage, ToolSpec } from '../llm/index.js';

// Context engineering helpers. Token counts are estimates (about 4 characters per token);
// providers tokenize differently, so treat them as relative sizes, not billing figures.

export const estimateTokens = (v: unknown): number => Math.ceil((typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length) / 4);

export interface Composition { system: number; tools: number; user: number; assistant: number; toolResults: number; total: number }

export function composition(system: string | undefined, tools: ToolSpec[] | undefined, messages: ChatMessage[]): Composition {
  let user = 0, assistant = 0, toolResults = 0;
  for (const m of messages) {
    if (m.role === 'user') user += estimateTokens(m.content);
    else if (m.role === 'assistant') assistant += estimateTokens(m.text) + estimateTokens(m.toolCalls);
    else toolResults += m.results.reduce((t, r) => t + estimateTokens(r.content), 0);
  }
  const sys = estimateTokens(system ?? ''), tl = estimateTokens(tools ?? []);
  return { system: sys, tools: tl, user, assistant, toolResults, total: sys + tl + user + assistant + toolResults };
}

// Keeps the start and end of an oversized tool result; the middle is usually the least useful.
export function clip(text: string, max: number): { text: string; clipped: number } {
  if (text.length <= max) return { text, clipped: 0 };
  const head = Math.floor(max * 0.7), tail = max - head;
  const cut = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n…[${cut.toLocaleString()} characters clipped by the context policy; ask for a narrower result if you need the middle]…\n${text.slice(-tail)}`,
    clipped: cut,
  };
}

export function transcriptForSummary(messages: ChatMessage[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`USER: ${m.content}`);
    else if (m.role === 'assistant') lines.push(`ASSISTANT: ${m.text}${m.toolCalls.length ? `\n[called ${m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input).slice(0, 200)})`).join(', ')}]` : ''}`);
    else lines.push(...m.results.map((r) => `TOOL ${r.name}${r.isError ? ' (error)' : ''}: ${r.content.slice(0, 1_500)}`));
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}
