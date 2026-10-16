import Anthropic from '@anthropic-ai/sdk';
import type { AgentCommand, AgentId } from '../types/index.js';
import { route } from '../core/router.js';
import { randomUUID } from 'crypto';

const claude = new Anthropic();

const SYSTEM = `You are TON, the master orchestrator AI for the WellOff real estate platform.
You coordinate a team of 5 specialized agents:

- ARIA: Real estate agent AI. Handles Meta Ads campaigns (listCampaigns, createCampaign, getCampaignInsights, createLeadForm, getLeadFormSubmissions, killCampaigns) and lead generation (findLeads).
- DEVX: Developer AI. Handles Google Ads campaigns (listGoogleCampaigns, createGoogleCampaign, getCampaignPerformance, getKeywordIdeas) and permit analysis (analyzePermits).
- TERRA: Land development AI. Handles parcel assessment (assessParcel) and GIS data search (searchGISData).
- CAPITA: Commercial investor AI. Handles NNN lease analysis (analyzeNNN) and commercial deal screening (screenDeals).
- NOVA: Non-commercial investor AI. Handles rental property analysis (rentalAnalysis) and foreclosure screening (foreclosureScreen).

Given any natural language command, determine the best agent and action to handle it.
Respond ONLY with valid JSON in this exact shape:
{
  "agentId": "<ARIA|DEVX|TERRA|CAPITA|NOVA>",
  "action": "<command name>",
  "params": { <any relevant parameters extracted from the input> }
}`;

interface DispatchPlan {
  agentId: AgentId;
  action: string;
  params: Record<string, unknown>;
}

export async function handle(command: AgentCommand): Promise<unknown> {
  const naturalLanguageInput =
    typeof command.params?.message === 'string'
      ? command.params.message
      : command.command;

  const msg = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    system: SYSTEM,
    messages: [{ role: 'user', content: naturalLanguageInput }],
  });

  const raw = msg.content.find((b) => b.type === 'text');
  if (!raw || raw.type !== 'text') {
    throw new Error('TON: Claude returned no text content');
  }

  let plan: DispatchPlan;
  try {
    plan = JSON.parse(raw.text) as DispatchPlan;
  } catch {
    throw new Error(`TON: could not parse dispatch plan from Claude response: ${raw.text}`);
  }

  const subCommand: AgentCommand = {
    id: randomUUID(),
    agentId: plan.agentId,
    command: plan.action,
    params: plan.params,
    timestamp: Date.now(),
  };

  const result = await route(subCommand);

  return {
    orchestratedBy: 'TON',
    plan,
    result,
  };
}
