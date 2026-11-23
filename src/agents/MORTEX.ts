import type { AgentCommand } from '../types/index.js';
import { MATERIALS, selectMaterials, type MaterialRequirements } from '../engineering/materials.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'select': {
      const r = (p.requirements && typeof p.requirements === 'object' ? p.requirements : p) as Record<string, unknown>;
      const n = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : undefined);
      const b = (k: string) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : undefined);
      const req: MaterialRequirements = {
        minSafetyFactor: n('minSafetyFactor'),
        designStressMPa: n('designStressMPa'),
        operatingTempC: n('operatingTempC'),
        tempMarginC: n('tempMarginC'),
        priority: r.priority === 'mass' || r.priority === 'cost' || r.priority === 'balanced' ? r.priority : undefined,
        corrosive: b('corrosive'),
        cyclic: b('cyclic'),
        bending: b('bending'),
        hint: typeof r.hint === 'string' ? r.hint : undefined,
      };
      return { requirements: req, ...selectMaterials(req) };
    }

    case 'library':
      return { materials: MATERIALS };

    default:
      throw new Error(`MORTEX: unknown command "${command.command}"`);
  }
}
