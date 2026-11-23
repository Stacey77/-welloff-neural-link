import type { AgentCommand } from '../types/index.js';
import { getProject, reverify } from '../engineering/index.js';

function id(p: Record<string, unknown>): string {
  if (typeof p.id !== 'string' || !p.id) throw new Error('SENTINEL: "id" is required');
  return p.id;
}

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'check': {
      const r = reverify(id(p));
      const proj = getProject(id(p));
      if (!r || !proj) throw new Error(`SENTINEL: unknown project "${p.id}"`);
      const live = r.live ?? r.design;
      return {
        id: proj.id,
        compliant: proj.compliance.compliant && live.overall !== 'fail',
        designVerification: r.design,
        liveVerification: r.live ?? null,
        findings: proj.compliance.findings.filter((f) => f.severity !== 'info'),
        rulesApplied: proj.compliance.rulesApplied,
        verificationRules: live.rules,
        references: proj.compliance.references,
        openAlerts: proj.alerts.filter((a) => !a.clearedAt),
      };
    }

    case 'alerts': {
      const proj = getProject(id(p));
      if (!proj) throw new Error(`SENTINEL: unknown project "${p.id}"`);
      return { id: proj.id, open: proj.alerts.filter((a) => !a.clearedAt), history: proj.alerts.slice(-100) };
    }

    default:
      throw new Error(`SENTINEL: unknown command "${command.command}"`);
  }
}
