import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'provisionCompute':
      return callMcpTool('provision_compute', p);

    case 'manageStorage':
      return callMcpTool('manage_storage', p);

    case 'configureNetworking':
      return callMcpTool('configure_networking', p);

    case 'autoScaleResource':
      return callMcpTool('auto_scale_resource', p);

    case 'optimizeCosts':
      return callMcpTool('optimize_costs', p);

    case 'monitorInfrastructure':
      return callMcpTool('monitor_infrastructure', p);

    default:
      throw new Error(`INFRA: unknown command "${command.command}"`);
  }
}
