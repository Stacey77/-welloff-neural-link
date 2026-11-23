import type { AgentCommand, AgentId } from '../types/index.js';
import { callMcpTool } from '../connectors/mcp-client.js';
import { platformTools, handlesTool, runPlatformTool } from '../tools/access.js';
import { a2aBus } from '../a2a/bus.js';
import { LlmSession, type ChatMessage, type ToolSpec } from '../llm/index.js';
import { runLoop } from '../harness/loop.js';
import { appendMemory, searchMemory, loadMemory } from '../memory/store.js';

const MEMORY: { role: 'user' | 'assistant'; content: string }[] = [];
const MAX_MEMORY = 20;

const SYSTEM = `You are BRAIN, the Agentic Cognitive Core of the WellOff neural-link platform.

You are the top-level reasoning, planning, and memory layer above TON. While TON dispatches tasks, BRAIN:
1. Maintains long-term context and learns from every interaction
2. Decomposes complex goals into multi-step agent workflows
3. Reflects on outcomes and adjusts strategy
4. Routes via A2A bus when direct agent communication is needed
5. Synthesizes cross-domain intelligence (real estate + tech + cloud + engineering)

AGENT ROSTER:
REAL ESTATE: ARIA (leads/ads), DEVX (Google Ads/territory), TERRA (property data), CAPITA (commercial), NOVA (residential/media)
TECHNOLOGY: NEXUS (tech intel), FORGE (robotics), ARCH (civil eng), VOLT (mechanical), MOTOR (automotive), MESH (networking)
CLOUD: INFRA (IaaS), PLAT (PaaS), XAAS (XaaS orchestration)
ORCHESTRATION: TON (master dispatcher)

BRAIN CAPABILITIES:
- plan: Break down complex multi-agent goals into ordered steps
- reflect: Analyze what worked and what didn't in past interactions
- remember: Store critical facts in long-term memory
- synthesize: Combine insights across domains
- delegate: Send A2A messages to specific agents
- monitor: Watch for cross-domain signals and surface alerts

Always return structured reasoning: {intent, plan, actions, synthesis}`;

const BRAIN_TOOLS: ToolSpec[] = [
  {
    name: 'plan_workflow',
    description: 'Decompose a complex goal into an ordered multi-agent execution plan',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The high-level objective' },
        context: { type: 'string', description: 'Additional context or constraints' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'delegate_to_agent',
    description: 'Send an A2A request to a specific agent and return its response',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Target agent ID (e.g. ARIA, NEXUS, INFRA)' },
        command: { type: 'string', description: 'Command name for that agent' },
        params: { type: 'object', description: 'Command parameters' },
      },
      required: ['agent', 'command'],
    },
  },
  {
    name: 'broadcast_insight',
    description: 'Broadcast a cross-domain insight or alert to all subscribed agents',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic name (e.g. market_alert, infra_anomaly)' },
        payload: { type: 'object', description: 'Insight data to broadcast' },
      },
      required: ['topic', 'payload'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Retrieve relevant past interactions and context from long-term memory',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in memory' },
      },
      required: ['query'],
    },
  },
  {
    name: 'call_mcp_tool',
    description: 'Directly call any MCP tool by name with parameters',
    input_schema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'MCP tool name' },
        params: { type: 'object', description: 'Tool parameters' },
      },
      required: ['tool'],
    },
  },
];

async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'plan_workflow': {
      const steps: string[] = [];
      const goal = String(input.goal ?? '');
      steps.push(`Analyzing goal: ${goal}`);
      steps.push('Identifying required agents and data sources');
      steps.push('Ordering steps by dependency');
      return { plan: steps, goal, status: 'generated' };
    }

    case 'delegate_to_agent': {
      const agentId = String(input.agent ?? '') as AgentId;
      const command = String(input.command ?? '');
      const params = (input.params ?? {}) as Record<string, unknown>;
      const resp = await a2aBus.send({
        type: 'request', from: 'BRAIN', to: agentId,
        command, params, payload: params,
      });
      return resp;
    }

    case 'broadcast_insight': {
      const topic = String(input.topic ?? '');
      const payload = input.payload ?? {};
      a2aBus.broadcast('BRAIN', topic, payload);
      return { broadcast: true, topic };
    }

    case 'recall_memory': {
      const query = String(input.query ?? '');
      const relevant = searchMemory(query);
      return { query, found: relevant.length, excerpts: relevant.slice(-5) };
    }

    case 'call_mcp_tool': {
      const tool = String(input.tool ?? '');
      const params = (input.params ?? {}) as Record<string, unknown>;
      return callMcpTool(tool, params);
    }

    default:
      throw new Error(`BRAIN: unknown tool "${name}"`);
  }
}

export async function handle(command: AgentCommand): Promise<unknown> {
  const userMessage =
    typeof command.params?.message === 'string' ? command.params.message : command.command;

  const allTools: ToolSpec[] = [...BRAIN_TOOLS, ...(await platformTools().catch(() => []))];

  const messages: ChatMessage[] = MEMORY.slice(-MAX_MEMORY).map((m): ChatMessage =>
    m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', text: m.content, toolCalls: [] },
  );
  messages.push({ role: 'user', content: userMessage });

  const session = new LlmSession('BRAIN', userMessage, typeof command.params?.model === 'string' ? command.params.model : undefined);
  const r = await runLoop({
    agent: 'BRAIN', session, system: SYSTEM, tools: allTools, messages, maxTokens: 8_000, task: userMessage,
    execute: async (call) => JSON.stringify(handlesTool(call.name) ? await runPlatformTool(call.name, call.input, 'BRAIN') : await executeTool(call.name, call.input)),
  });
  const finalText = r.text || 'Cognitive processing complete.';
  const iterations = r.steps;

  MEMORY.push({ role: 'user', content: userMessage });
  if (finalText) MEMORY.push({ role: 'assistant', content: finalText });
  while (MEMORY.length > MAX_MEMORY * 2) MEMORY.splice(0, 2);
  appendMemory({ role: 'user', content: userMessage, timestamp: Date.now() });
  if (finalText) appendMemory({ role: 'assistant', content: finalText, timestamp: Date.now() });

  return {
    cognitiveCore: 'BRAIN',
    summary: finalText || 'Reasoning complete',
    memorySize: MEMORY.length,
    iterations,
    models: [...session.used],
    route: session.decision.reason,
    stop: r.stop,
    runId: r.runId,
  };
}
