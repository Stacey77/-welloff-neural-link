import type { Request, Response } from 'express';
import { platformTools, runPlatformTool } from '../tools/access.js';
import { LlmSession, type ToolSpec } from '../llm/index.js';
import { runLoop } from '../harness/loop.js';
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
    const tools: ToolSpec[] = await platformTools();
    const session = new LlmSession('TON', message, typeof req.query.model === 'string' ? req.query.model : undefined);
    send({ type: 'route', model: session.decision.spec, reason: session.decision.reason });
    let lastText = '';
    const r = await runLoop({
      agent: 'TON', session, system: SYSTEM, tools, maxTokens: 8_000,
      messages: [{ role: 'user', content: message }],
      execute: async (call) => JSON.stringify(await runPlatformTool(call.name, call.input, 'TON')),
      hooks: {
        onModel: (res, step) => {
          send({ type: 'thinking', iteration: step - 1 });
          for (const a of res.attempts.filter((x) => !x.ok)) send({ type: 'fallback', from: a.spec, error: a.error });
          if (res.text) { send({ type: 'token', text: res.text, model: res.spec }); lastText = res.text; }
          if (res.toolCalls.length) send({ type: 'tools_start', count: res.toolCalls.length });
        },
        onToolStart: (call) => send({ type: 'tool_use', name: call.name }),
        onToolEnd: (call, out) => send({ type: 'tool_result', name: call.name, preview: out.slice(0, 120) }),
        onCompact: () => send({ type: 'compacted' }),
      },
    });
    send({ type: 'done', summary: r.text || lastText, model: r.models[r.models.length - 1], stop: r.stop, runId: r.runId });
    res.end();
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    res.end();
  }
}
