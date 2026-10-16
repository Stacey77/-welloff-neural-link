import { callMcpTool } from '../connectors/mcp-client.js';
import type { AgentCommand } from '../types/index.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'mapNetworkTopology':
      return callMcpTool('map_network_topology', p);

    case 'detectTrafficAnomalies':
      return callMcpTool('detect_traffic_anomalies', p);

    case 'generateIac':
      return callMcpTool('generate_iac', p);

    case 'auditFirewallRules':
      return callMcpTool('audit_firewall_rules', p);

    case 'scanVulnerabilities':
      return callMcpTool('scan_vulnerabilities', p);

    default:
      throw new Error(`MESH: unknown command "${command.command}"`);
  }
}
