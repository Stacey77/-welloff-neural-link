import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentCommand } from '../types/index.js';

const claude = new Anthropic();
const AGENTS_DIR = __dirname;

const SYSTEM = `You are GENESIS, a meta-agent that generates TypeScript agent code for the WellOff neural-link platform.

Output ONLY valid TypeScript file content (no markdown fences, no explanation) for a new agent that:
1. Imports: import { callMcpTool } from '../connectors/mcp-client.js'; import type { AgentCommand } from '../types/index.js';
2. Exports: export async function handle(command: AgentCommand): Promise<unknown>
3. Uses switch(command.command) to map commands to callMcpTool() calls
4. Each case: return callMcpTool('tool_name', command.params ?? {})
5. Default: throw new Error('AGENTNAME: unknown command "'+command.command+'"')

The output is ONLY the TypeScript file. No markdown. No explanation.`;

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'generateAgent': {
      const name = String(p.name ?? 'CUSTOM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const description = String(p.description ?? 'Custom agent');
      const tools = Array.isArray(p.tools) ? (p.tools as string[]) : [];

      if (!name) throw new Error('GENESIS: agent name required');

      const filename = join(AGENTS_DIR, `${name}.ts`);
      if (existsSync(filename)) throw new Error(`GENESIS: agent ${name} already exists at ${filename}`);

      const prompt = `Create a TypeScript agent file.
Agent name: ${name}
Purpose: ${description}
MCP tools to implement (one switch case per tool, map command name → mcp tool name):
${tools.map((t, i) => `  case '${t}': → callMcpTool('${t}', p)`).join('\n')}

Output only the TypeScript file content.`;

      const response = await claude.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      });

      const code = response.content.find(b => b.type === 'text')?.type === 'text'
        ? (response.content.find(b => b.type === 'text') as { type: 'text'; text: string }).text
        : '';

      if (!code.trim()) throw new Error('GENESIS: no code generated');

      writeFileSync(filename, code, 'utf8');

      return {
        generated: true,
        agentId: name,
        filename,
        linesOfCode: code.split('\n').length,
        preview: code.slice(0, 400) + (code.length > 400 ? '...' : ''),
        note: 'Restart neural-link server to register the new agent (add to types/index.ts and core/router.ts)',
      };
    }

    case 'describeCapabilities':
      return {
        agent: 'GENESIS',
        purpose: 'Generate new specialized TypeScript agents from natural language descriptions',
        commands: ['generateAgent'],
        params: { name: 'string (agent ID, A-Z)', description: 'string (what it does)', tools: 'string[] (MCP tool names)' },
      };

    default:
      throw new Error(`GENESIS: unknown command "${command.command}"`);
  }
}
