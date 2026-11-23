---
name: write-an-agent
description: Conventions for adding a new neural-link agent (file layout, handler signature, router and type registration, LLM access).
---
# Writing a neural-link agent

- File: `src/agents/<NAME>.ts`, NAME in capitals.
- Export `async function handle(command: AgentCommand): Promise<unknown>` and switch on `command.command`; throw `new Error('<NAME>: unknown command "<x>"')` for unknown commands.
- Imports use `.js` extensions: `import type { AgentCommand } from '../types/index.js';`.
- MCP tools: `callMcpTool(name, params)` from `../connectors/mcp-client.js`.
- LLM calls: `ask('<ASSIGNABLE>', prompt, { system })` or `new LlmSession(...)` from `../llm/index.js`. Never construct a provider SDK client directly; the LLM layer applies routing, fallback, guardrails and tracing.
- Register: add the id to the `AgentId` union and `AgentIdSchema` in `src/types/index.ts`, import the handler in `src/core/router.ts` and add it to `handlers`, and add it to `AGENTS` in `src/index.ts`. Unregistered agent files are reported as hidden agents by the security inventory.
- Run the typecheck before finishing.
