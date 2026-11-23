import type { Request, Response } from 'express';
import { listMcpTools, callMcpTool } from '../connectors/mcp-client.js';
import { LlmSession, type ChatMessage, type ToolSpec } from '../llm/index.js';
import { SYSTEM } from '../agents/TON.js';

export async function streamTon(req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (data: object) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  const message = String(req.query.message ?? '').trim();
  if (!message) {
    send({ type: 'error', message: 'message query param required' });
    res.end();
    return;
  }

  try {
    const tools: ToolSpec[] = (await listMcpTools()).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
    const session = new LlmSession('TON', message, typeof req.query.model === 'string' ? req.query.model : undefined);
    send({ type: 'route', model: session.decision.spec, reason: session.decision.reason });
    const messages: ChatMessage[] = [{ role: 'user', content: message }];

    for (let i = 0; i < 6; i++) {
      send({ type: 'thinking', iteration: i });
      const r = await session.turn({ system: SYSTEM, tools, messages, maxTokens: 8_000 });
      for (const a of r.attempts.filter((x) => !x.ok)) send({ type: 'fallback', from: a.spec, error: a.error });
      if (r.text) send({ type: 'token', text: r.text, model: r.spec });
      if (r.stop !== 'tool_use' || !r.toolCalls.length) {
        send({ type: 'done', summary: r.text, model: r.spec });
        res.end();
        return;
      }
      send({ type: 'tools_start', count: r.toolCalls.length });
      messages.push(r.assistant);
      const results = await Promise.all(
        r.toolCalls.map(async (call) => {
          send({ type: 'tool_use', name: call.name });
          try {
            const out = JSON.stringify(await callMcpTool(call.name, call.input));
            send({ type: 'tool_result', name: call.name, preview: out.slice(0, 120) });
            return { id: call.id, name: call.name, content: out };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send({ type: 'tool_result', name: call.name, preview: msg.slice(0, 120) });
            return { id: call.id, name: call.name, content: msg, isError: true };
          }
        }),
      );
      messages.push({ role: 'tool', results });
    }
    send({ type: 'done', summary: 'Orchestration stopped after the step limit' });
    res.end();
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    res.end();
  }
}
