import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'assessParcel':
    case 'getPropertyDetails':
      return callMcpTool('get_property_details', p);

    case 'searchGISData':
    case 'searchProperties':
      return callMcpTool('search_properties', p);

    case 'getMovementScore':
      return callMcpTool('calculate_movement_score', p);

    case 'getTaxRecords':
      return callMcpTool('get_tax_records', p);

    case 'getComparableSales':
      return callMcpTool('get_comparable_sales', p);

    case 'claimTerritory':
      return callMcpTool('claim_territory', p);

    default:
      throw new Error(`TERRA: unknown command "${command.command}"`);
  }
}
