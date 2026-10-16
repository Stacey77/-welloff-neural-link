import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'getFleetTelemetry':
      return callMcpTool('get_fleet_telemetry', p);

    case 'diagnoseFaultCode':
      return callMcpTool('diagnose_fault_code', p);

    case 'analyzeBatteryHealth':
      return callMcpTool('analyze_battery_health', p);

    case 'checkAdasCalibration':
      return callMcpTool('check_adas_calibration', p);

    case 'runEmissionsCompliance':
      return callMcpTool('run_emissions_compliance', p);

    default:
      throw new Error(`MOTOR: unknown command "${command.command}"`);
  }
}
