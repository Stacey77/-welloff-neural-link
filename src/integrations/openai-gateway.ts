import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { availableModels, chat, route, type ChatMessage, type ToolSpec } from '../llm/index.js';
import { modelInfo, splitSpec } from '../llm/catalog.js';
import type { Policy } from '../llm/settings.js';

// OpenAI-compatible endpoint over the multi-LLM router, so LangChain's ChatOpenAI, LangGraph,
// Lindy custom models or any OpenAI client can use every configured provider with fallbacks.

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const POLICIES = ['quality', 'balanced', 'economy', 'speed'];

function guard(req: Request, res: Response, next: NextFunction): void {
  const required = process.env.NEURAL_API_KEY;
  const auth = String(req.headers.authorization ?? '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-api-key'] ?? '');
  if (required) {
    if (given !== required) {
      res.status(401).json({ error: { message: 'Invalid API key. Use NEURAL_API_KEY as the bearer token.', type: 'invalid_request_error' } });
      return;
    }
  } else if (!LOCAL.has(String(req.headers.host ?? '').replace(/:\d+$/, ''))) {
    res.status(403).json({ error: { message: 'The gateway is local-only until NEURAL_API_KEY is set.', type: 'invalid_request_error' } });
    return;
  }
  next();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  return content == null ? '' : String(content);
}

function convert(messages: any[]): { system: string; messages: ChatMessage[] } {
  const system: string[] = [];
  const out: ChatMessage[] = [];
  const names = new Map<string, string>();
  for (const m of messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') system.push(textOf(m.content));
    else if (m.role === 'user') out.push({ role: 'user', content: textOf(m.content) });
    else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls ?? []).map((c: any) => {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
        names.set(c.id, c.function?.name ?? '');
        return { id: c.id, name: c.function?.name ?? '', input };
      });
      out.push({ role: 'assistant', text: textOf(m.content), toolCalls });
    } else if (m.role === 'tool') {
      const result = { id: String(m.tool_call_id), name: names.get(m.tool_call_id) ?? '', content: textOf(m.content) };
      const last = out[out.length - 1];
      if (last?.role === 'tool') last.results.push(result);
      else out.push({ role: 'tool', results: [result] });
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

function chainFor(model: string, hint: string): { chain: string[]; reason: string } {
  const m = model.replace(/^neural-link\//, '');
  if (!m || m === 'auto' || m.startsWith('auto:')) {
    const policy = m.startsWith('auto:') ? m.slice(5) : undefined;
    if (policy && !POLICIES.includes(policy)) throw new Error(`Unknown policy ${policy}. Use auto:${POLICIES.join(', auto:')}.`);
    const d = route(hint, { policy: policy as Policy | undefined });
    return { chain: d.chain, reason: d.reason };
  }
  splitSpec(m);
  const d = route(hint, { policy: modelInfo(m)?.tier === 'fast' ? 'speed' : modelInfo(m)?.tier === 'frontier' ? 'quality' : 'balanced' });
  return { chain: [m, ...d.chain.filter((s) => s !== m)], reason: `Requested ${m}.` };
}

export const gatewayRouter = Router();
gatewayRouter.use(guard);

gatewayRouter.get('/models', (_req, res) => {
  const ids = ['auto', ...POLICIES.map((p) => `auto:${p}`), ...availableModels()];
  res.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: id.startsWith('auto') ? 'neural-link' : id.split(':')[0] })) });
});

gatewayRouter.post('/chat/completions', async (req, res) => {
  const body = req.body ?? {};
  try {
    const { system, messages } = convert(body.messages);
    if (!messages.length) throw new Error('messages must include at least one user message');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const { chain, reason } = chainFor(String(body.model ?? 'auto'), lastUser && lastUser.role === 'user' ? lastUser.content : '');
    const tools: ToolSpec[] = (body.tools ?? [])
      .filter((t: any) => t?.type === 'function' && t.function?.name)
      .map((t: any) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
    const r = await chat(chain, { system: system || undefined, messages, tools, maxTokens: Number(body.max_completion_tokens ?? body.max_tokens) || undefined }, { agent: 'GATEWAY' });

    const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const toolCalls = r.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
    const finish = r.stop === 'tool_use' ? 'tool_calls' : r.stop === 'max_tokens' ? 'length' : 'stop';
    res.setHeader('x-neural-link-model', r.spec);
    res.setHeader('x-neural-link-route', reason.slice(0, 300).replace(/[^\x20-\x7e]/g, ''));

    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const chunk = (delta: object, finish_reason: string | null, extra: object = {}) =>
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: r.spec, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
      chunk({ role: 'assistant', content: r.text || '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, null);
      chunk({}, finish, { usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.json({
      id, object: 'chat.completion', created, model: r.spec,
      choices: [{ index: 0, message: { role: 'assistant', content: r.text || null, ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index, ...c }) => c) } : {}) }, finish_reason: finish }],
      usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output },
    });
  } catch (err) {
    res.status(400).json({ error: { message: err instanceof Error ? err.message : String(err), type: 'invalid_request_error' } });
  }
});
