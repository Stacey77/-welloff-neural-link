import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'listCampaigns':
      return callMcpTool('list_meta_campaigns', {});

    case 'createCampaign':
      return callMcpTool('create_meta_campaign', p);

    case 'createAdSet':
      return callMcpTool('create_meta_ad_set', p);

    case 'getCampaignInsights':
      return callMcpTool('get_meta_campaign_insights', p);

    case 'createLeadForm':
      return callMcpTool('create_lead_form', p);

    case 'getLeadFormSubmissions':
      return callMcpTool('get_lead_form_submissions', p);

    case 'updateCampaignStatus':
      return callMcpTool('update_meta_campaign_status', p);

    case 'killCampaigns':
      return callMcpTool('kill_meta_campaigns', p);

    case 'findLeads':
      return callMcpTool('search_leads', p);

    case 'enrichLead':
      return callMcpTool('enrich_lead', p);

    case 'scheduleFollowup':
      return callMcpTool('schedule_followup', p);

    default:
      throw new Error(`ARIA: unknown command "${command.command}"`);
  }
}
