import Anthropic from '@anthropic-ai/sdk';
import type { AgentCommand } from '../types/index.js';

const claude = new Anthropic();

const SYSTEM =
  'You are CAPITA, a commercial real estate investor AI for the WellOff platform. ' +
  'You specialize in NNN lease analysis, cap rate evaluation, commercial deal screening, ' +
  'and institutional-grade investment due diligence.';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'analyzeNNN': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Analyze this NNN lease deal: ${JSON.stringify(p)}`,
          },
        ],
      });
      return msg.content;
    }

    case 'screenDeals': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Screen these commercial deals against investment criteria: ${JSON.stringify(p)}`,
          },
        ],
      });
      return msg.content;
    }

    default:
      throw new Error(`CAPITA: unknown command "${command.command}"`);
  }
}
