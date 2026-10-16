import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';
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

export async function streamTon(req: any, res: any): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  function send(data: object): void {
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  const message = String(req.query.message ?? '').trim();
  if (!message) {
    send({ type: 'error', message: 'message query param required' });
    res.end();
    return;
  }

  try {
    const mcpTools = await listMcpTools();
    const tools: Tool[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: (t.inputSchema as Tool['input_schema']) ?? { type: 'object', properties: {} },
    }));

    const messages: MessageParam[] = [{ role: 'user', content: message }];

    const MAX_ITERATIONS = 6;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      send({ type: 'thinking', iteration: i });

      const response = await claude.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM,
        tools,
        messages,
      });

      recordTokenUsage('TON', response.usage);

      for (const block of response.content) {
        if (block.type === 'text') {
          send({ type: 'token', text: block.text });
        }
      }

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b) => b.type === 'text');
        const text = textBlock?.type === 'text' ? textBlock.text : '';
        send({ type: 'done', summary: text });
        res.end();
        return;
      }

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
        send({ type: 'tools_start', count: toolBlocks.length });

        messages.push({ role: 'assistant', content: response.content });

        const toolResults = await Promise.all(
          toolBlocks.map(async (block: any) => {
            send({ type: 'tool_use', name: block.name });
            let result: unknown;
            try {
              result = await callMcpTool(block.name, block.input);
            } catch (err) {
              result = { error: err instanceof Error ? err.message : String(err) };
            }
            send({ type: 'tool_result', name: block.name, preview: JSON.stringify(result).slice(0, 120) });
            return { type: 'tool_result' as const, tool_use_id: block.id, content: JSON.stringify(result) };
          }),
        );

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // unexpected stop_reason — exit loop
      break;
    }

    send({ type: 'done', summary: 'Orchestration complete' });
    res.end();
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    res.end();
  }
}
