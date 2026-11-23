import type { AgentCommand } from '../types/index.js';
import { lindyStatus, trigger } from '../integrations/lindy.js';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;
  switch (command.command) {
    case 'trigger':
      return trigger((p.payload as Record<string, unknown>) ?? p);
    case 'status':
      return lindyStatus();
    default:
      throw new Error(`LINDY: unknown command "${command.command}". Use trigger or status.`);
  }
}
