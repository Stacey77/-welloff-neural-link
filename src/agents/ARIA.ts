import Anthropic from '@anthropic-ai/sdk';
import { callMetaAds } from '../connectors/welloff-api.js';
import type { AgentCommand } from '../types/index.js';

const claude = new Anthropic();

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'listCampaigns':
      return callMetaAds('listCampaigns', p);

    case 'createCampaign':
      return callMetaAds('createCampaign', p);

    case 'getCampaignInsights':
      return callMetaAds('getCampaignInsights', p);

    case 'createLeadForm':
      return callMetaAds('createLeadForm', p);

    case 'getLeadFormSubmissions':
      return callMetaAds('getLeadFormSubmissions', p);

    case 'killCampaigns':
      return callMetaAds('killCampaigns', p);

    case 'findLeads': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system:
          'You are ARIA, a real estate agent AI for the WellOff platform. ' +
          'Generate qualified lead criteria and outreach strategies based on the given context.',
        messages: [{ role: 'user', content: JSON.stringify(p) }],
      });
      return msg.content;
    }

    default:
      throw new Error(`ARIA: unknown command "${command.command}"`);
  }
}
