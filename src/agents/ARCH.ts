import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'runBimClashDetection':
      return callMcpTool('run_bim_clash_detection', p);

    case 'getPermitStatus':
      return callMcpTool('get_permit_status', p);

    case 'calculateStructuralLoads':
      return callMcpTool('calculate_structural_loads', p);

    case 'checkCodeCompliance':
      return callMcpTool('check_code_compliance', p);

    case 'estimateProjectCost':
      return callMcpTool('estimate_project_cost', p);

    default:
      throw new Error(`ARCH: unknown command "${command.command}"`);
  }
}
