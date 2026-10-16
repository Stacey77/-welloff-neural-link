import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'listGoogleCampaigns':
      return callMcpTool('list_google_campaigns', {});

    case 'createGoogleCampaign':
      return callMcpTool('create_google_campaign', p);

    case 'getCampaignPerformance':
      return callMcpTool('get_campaign_performance', p);

    case 'getKeywordIdeas':
      return callMcpTool('get_keyword_ideas', p);

    case 'createAdGroup':
      return callMcpTool('create_ad_group', p);

    case 'getTerritoryIntel':
      return callMcpTool('get_territory_intel', p);

    case 'findOpportunityZips':
      return callMcpTool('find_opportunity_zips', p);

    case 'scanZoningChanges':
      return callMcpTool('scan_zoning_changes', p);

    case 'analyzePermits':
      return callMcpTool('scan_zoning_changes', p);

    default:
      throw new Error(`DEVX: unknown command "${command.command}"`);
  }
}
