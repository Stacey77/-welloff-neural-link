import Anthropic from '@anthropic-ai/sdk';
import { callGoogleAds } from '../connectors/welloff-api.js';
import type { AgentCommand } from '../types/index.js';

const claude = new Anthropic();

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'listGoogleCampaigns':
      return callGoogleAds('listCampaigns', p);

    case 'createGoogleCampaign':
      return callGoogleAds('createCampaign', p);

    case 'getCampaignPerformance':
      return callGoogleAds('getCampaignPerformance', p);

    case 'getKeywordIdeas':
      return callGoogleAds('getKeywordIdeas', p);

    case 'analyzePermits': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system:
          'You are DEVX, a developer AI for the WellOff platform. ' +
          'Analyze building permits, zoning data, and development opportunities.',
        messages: [{ role: 'user', content: JSON.stringify(p) }],
      });
      return msg.content;
    }

    default:
      throw new Error(`DEVX: unknown command "${command.command}"`);
  }
}
