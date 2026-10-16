import Anthropic from '@anthropic-ai/sdk';
import type { AgentCommand } from '../types/index.js';

const claude = new Anthropic();

const SYSTEM =
  'You are TERRA, a land development AI for the WellOff platform. ' +
  'You specialize in parcel assessment, GIS data interpretation, entitlement analysis, ' +
  'and land development feasibility.';

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'assessParcel': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Assess this parcel for development potential: ${JSON.stringify(p)}`,
          },
        ],
      });
      return msg.content;
    }

    case 'searchGISData': {
      const msg = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Search and interpret GIS data for: ${JSON.stringify(p)}`,
          },
        ],
      });
      return msg.content;
    }

    default:
      throw new Error(`TERRA: unknown command "${command.command}"`);
  }
}
