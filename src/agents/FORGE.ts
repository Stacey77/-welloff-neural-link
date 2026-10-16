import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'getFleetStatus':
      return callMcpTool('get_robot_fleet_status', p);

    case 'scheduleMaintenance':
      return callMcpTool('schedule_maintenance', p);

    case 'runRosSimulation':
      return callMcpTool('run_ros_simulation', p);

    case 'analyzeSensorData':
      return callMcpTool('analyze_sensor_data', p);

    case 'optimizePathPlanning':
      return callMcpTool('optimize_path_planning', p);

    default:
      throw new Error(`FORGE: unknown command "${command.command}"`);
  }
}

export async function runAutonomousScan(): Promise<void> {
  const { callMcpTool: call } = await import('../connectors/mcp-client.js');
  await call('get_robot_fleet_status', { includeAlerts: true, auto: true });
}
