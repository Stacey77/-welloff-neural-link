import type { AgentCommand } from '../types/index.js';
import { createProject, getProject, listProjects, reverify, startSimulation, stopSimulation, type Priority } from '../engineering/index.js';

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`AXIOM: "${key}" is required`);
  return v.trim();
}

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'plan':
      return createProject(str(p, 'goal'), {
        targetSafetyFactor: typeof p.targetSafetyFactor === 'number' ? p.targetSafetyFactor : undefined,
        priority: p.priority === 'mass' || p.priority === 'cost' || p.priority === 'balanced' ? (p.priority as Priority) : undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
        llm: typeof p.llm === 'boolean' ? p.llm : undefined,
      });

    case 'status': {
      const proj = getProject(str(p, 'id'));
      if (!proj) throw new Error(`AXIOM: unknown project "${p.id}"`);
      return {
        id: proj.id, goal: proj.goal, planSource: proj.planSource, planModel: proj.planModel,
        swarm: proj.swarm.nodes.map((n) => ({ id: n.id, status: n.status, summary: n.summary })),
        designs: proj.designs.map((d) => ({ componentId: d.componentId, material: d.materialName, section: d.dims, sf: d.results.sf })),
        verification: proj.telemetry.lastVerification ?? proj.verification,
        telemetry: { running: proj.telemetry.running, simulated: proj.telemetry.simulated },
        openAlerts: proj.alerts.filter((a) => !a.clearedAt),
      };
    }

    case 'list':
      return listProjects();

    case 'simulate': {
      const id = str(p, 'id');
      const proj = p.on === false ? stopSimulation(id) : startSimulation(id);
      if (!proj) throw new Error(`AXIOM: unknown project "${id}"`);
      return { id, running: proj.telemetry.running, simulated: proj.telemetry.simulated };
    }

    case 'verify': {
      const r = reverify(str(p, 'id'));
      if (!r) throw new Error(`AXIOM: unknown project "${p.id}"`);
      return r;
    }

    default:
      throw new Error(`AXIOM: unknown command "${command.command}"`);
  }
}
