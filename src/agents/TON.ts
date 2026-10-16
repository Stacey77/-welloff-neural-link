import Anthropic from '@anthropic-ai/sdk';
import type { Tool, MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { AgentCommand } from '../types/index.js';
import { listMcpTools, callMcpTool } from '../connectors/mcp-client.js';

const claude = new Anthropic();

const SYSTEM = `You are TON (Total Operations Navigator), the master orchestrator AI for the WellOff real estate platform.
You coordinate 5 specialized agents — ARIA (leads & Meta Ads), DEVX (Google Ads & territory), TERRA (land & property), CAPITA (commercial), NOVA (media & residential) — by calling their tools directly.
Use the available tools to fulfill the user's request. Call multiple tools if needed. Always return a concise summary of what was accomplished.`;

export async function handle(command: AgentCommand): Promise<unknown> {
  const userMessage =
    typeof command.params?.message === 'string' ? command.params.message : command.command;

  const mcpTools = await listMcpTools();

  const tools: Tool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.inputSchema as Tool['input_schema']) ?? { type: 'object', properties: {} },
  }));

  const messages: MessageParam[] = [{ role: 'user', content: userMessage }];

  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system: SYSTEM,
      tools,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find((b) => b.type === 'text');
      return { orchestratedBy: 'TON', summary: text?.type === 'text' ? text.text : 'Done' };
    }

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: MessageParam['content'] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      let toolResult: unknown;
      try {
        toolResult = await callMcpTool(block.name, block.input as Record<string, unknown>);
      } catch (err) {
        toolResult = { error: err instanceof Error ? err.message : String(err) };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(toolResult),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { orchestratedBy: 'TON', summary: 'Orchestration complete', iterations };
}
