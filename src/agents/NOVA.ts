import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'rentalAnalysis':
    case 'searchProperties':
      return callMcpTool('search_properties', p);

    case 'foreclosureScreen':
    case 'searchLeads':
      return callMcpTool('search_leads', { ...p, signalType: 'Pre-foreclosure Alert' });

    case 'generateSocialContent':
      return callMcpTool('generate_social_content', p);

    case 'createPropertyVideo':
      return callMcpTool('create_property_video', p);

    case 'generateVirtualStaging':
      return callMcpTool('generate_virtual_staging', p);

    case 'createPropertyFlyer':
      return callMcpTool('create_property_flyer', p);

    default:
      throw new Error(`NOVA: unknown command "${command.command}"`);
  }
}
