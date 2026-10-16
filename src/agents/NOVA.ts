import Anthropic from '@anthropic-ai/sdk';
import type { AgentCommand } from '../types/index.js';

const claude = new Anthropic();

const SYSTEM =
  'You are NOVA, a non-commercial real estate investor AI for the WellOff platform. ' +
  'You specialize in residential rental analysis, foreclosure screening, fix-and-flip evaluation, ' +
  'and residential portfolio optimization.';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'rentalAnalysis': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Perform rental property analysis: ${JSON.stringify(p)}`,
          },
        ],
      });
      return msg.content;
    }

    case 'foreclosureScreen': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Screen these foreclosure opportunities: ${JSON.stringify(p)}`,
          },
        ],
      });
      return msg.content;
    }

    default:
      throw new Error(`NOVA: unknown command "${command.command}"`);
  }
}
