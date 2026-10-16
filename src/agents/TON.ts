import Anthropic from '@anthropic-ai/sdk';
import type { Tool, MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { AgentCommand } from '../types/index.js';
import { listMcpTools, callMcpTool } from '../connectors/mcp-client.js';
import { recordTokenUsage } from '../observability/metrics.js';

const claude = new Anthropic();

const SYSTEM = `You are TON (Total Operations Navigator), the master orchestrator AI for the WellOff universal agent platform.
You coordinate 15 specialized agents by calling their MCP tools directly:

REAL ESTATE:
- ARIA: real estate leads, Meta Ads campaigns, lead enrichment, follow-up sequences
- DEVX: Google Ads, territory intelligence, zoning/permit monitoring
- TERRA: property data, structural assessment, GIS, movement scores, land analysis
- CAPITA: commercial investment, NNN leases, comps, deal documents
- NOVA: residential investment, media generation, virtual staging, social content

TECHNOLOGY & ENGINEERING:
- NEXUS: tech sector intelligence, SaaS metrics, funding rounds, acquisition targets, talent signals
- FORGE: AI robotics fleet management, ROS simulation, maintenance scheduling, path planning
- ARCH: civil & structural engineering — BIM clash detection, permits, load calculations, code compliance
- VOLT: mechanical engineering — FEA analysis, material selection, fatigue analysis, DFMEA
- MOTOR: automotive engineering — fleet telemetry, fault diagnosis, EV battery health, ADAS, emissions
- MESH: computer networking — topology mapping, anomaly detection, IaC generation, firewall audits, CVE scanning

CLOUD & AS-A-SERVICE:
- INFRA (IaaS): compute provisioning, storage management, networking, auto-scaling, cost optimization, infrastructure monitoring
- PLAT (PaaS): application deployment, CI/CD pipelines, managed databases, service scaling, runtime management, platform monitoring
- XAAS (XaaS): multi-tenant provisioning, billing management, SLA enforcement, API gateway, service catalog, white-label deployment

COGNITIVE CORE:
- BRAIN: agentic reasoning, workflow planning, cross-domain synthesis, long-term memory, A2A orchestration

Use the available tools to fulfill the user's request. Call multiple tools across agents if needed. Return a concise summary of what was accomplished.`;

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

    recordTokenUsage('TON', response.usage);

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find((b) => b.type === 'text');
      return { orchestratedBy: 'TON', summary: text?.type === 'text' ? text.text : 'Done' };
    }

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter((b): b is import('@anthropic-ai/sdk/resources/messages.js').ToolUseBlock => b.type === 'tool_use');
    const toolResults: MessageParam['content'] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let result: unknown;
        try {
          result = await callMcpTool(block.name, block.input as Record<string, unknown>);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        return { type: 'tool_result' as const, tool_use_id: block.id, content: JSON.stringify(result) };
      })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  return { orchestratedBy: 'TON', summary: 'Orchestration complete', iterations };
}
