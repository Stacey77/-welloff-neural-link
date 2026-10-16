import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'scanTechFunding':
      return callMcpTool('scan_tech_funding', p);

    case 'trackSaasMetrics':
      return callMcpTool('track_saas_metrics', p);

    case 'findAcquisitionTargets':
      return callMcpTool('find_acquisition_targets', p);

    case 'monitorTalentSignals':
      return callMcpTool('monitor_talent_signals', p);

    case 'analyzeTechStack':
      return callMcpTool('analyze_tech_stack', p);

    default:
      throw new Error(`NEXUS: unknown command "${command.command}"`);
  }
}
