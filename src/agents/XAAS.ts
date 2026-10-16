import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'provisionTenant':
      return callMcpTool('provision_tenant', p);

    case 'manageBilling':
      return callMcpTool('manage_billing', p);

    case 'enforceSla':
      return callMcpTool('enforce_sla', p);

    case 'manageApiGateway':
      return callMcpTool('manage_api_gateway', p);

    case 'generateServiceCatalog':
      return callMcpTool('generate_service_catalog', p);

    case 'deployWhiteLabel':
      return callMcpTool('deploy_white_label', p);

    default:
      throw new Error(`XAAS: unknown command "${command.command}"`);
  }
}
