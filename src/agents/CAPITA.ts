import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'analyzeNNN':
    case 'getComparableSales':
      return callMcpTool('get_comparable_sales', p);

    case 'screenDeals':
    case 'searchProperties':
      return callMcpTool('search_properties', p);

    case 'getPropertyDetails':
      return callMcpTool('get_property_details', p);

    case 'generateDocument':
      return callMcpTool('generate_document', p);

    default:
      throw new Error(`CAPITA: unknown command "${command.command}"`);
  }
}
