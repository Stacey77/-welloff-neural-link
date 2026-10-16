import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'runFeaAnalysis':
      return callMcpTool('run_fea_analysis', p);

    case 'selectMaterial':
      return callMcpTool('select_material', p);

    case 'analyzeFatigueFailure':
      return callMcpTool('analyze_fatigue_failure', p);

    case 'optimizeGeometry':
      return callMcpTool('optimize_geometry', p);

    case 'generateDfmea':
      return callMcpTool('generate_dfmea', p);

    default:
      throw new Error(`VOLT: unknown command "${command.command}"`);
  }
}
