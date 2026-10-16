import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'deployApplication':
      return callMcpTool('deploy_application', p);

    case 'managePipeline':
      return callMcpTool('manage_pipeline', p);

    case 'provisionDatabase':
      return callMcpTool('provision_database', p);

    case 'scaleService':
      return callMcpTool('scale_service', p);

    case 'manageRuntime':
      return callMcpTool('manage_runtime', p);

    case 'monitorPlatform':
      return callMcpTool('monitor_platform', p);

    default:
      throw new Error(`PLAT: unknown command "${command.command}"`);
  }
}
