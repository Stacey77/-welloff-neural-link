import type { AgentCommand } from '../types/index.js';
import { ask, compare, council, describe, discover, route } from '../llm/index.js';
import { updateSettings, type Policy } from '../llm/settings.js';

// MAESTRO conducts the platform's LLMs: it routes each request to a model, falls back across
// providers on failure, and runs several models side by side with a judge.
export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;
  const prompt = String(p.prompt ?? p.message ?? '');
  const models = Array.isArray(p.models) ? (p.models as unknown[]).map(String) : [];

  switch (command.command) {
    case 'providers':
      return describe();

    case 'route':
      if (!prompt) throw new Error('MAESTRO.route needs a prompt');
      return route(prompt, { policy: p.policy as Policy | undefined });

    case 'ask': {
      if (!prompt) throw new Error('MAESTRO.ask needs a prompt');
      const r = await ask('TON', prompt, { model: p.model ? String(p.model) : undefined, system: p.system ? String(p.system) : undefined });
      return { model: r.spec, answer: r.text, decision: r.decision, attempts: r.attempts, usage: r.usage, costUsd: r.costUsd, latencyMs: r.latencyMs };
    }

    case 'compare':
      if (!prompt) throw new Error('MAESTRO.compare needs a prompt');
      return { prompt, results: await compare(prompt, models) };

    case 'council':
      if (!prompt) throw new Error('MAESTRO.council needs a prompt');
      return { prompt, ...(await council(prompt, models, p.judge ? String(p.judge) : undefined)) };

    case 'setPolicy':
      return updateSettings({ policy: String(p.policy) as Policy });

    case 'assign':
      return updateSettings({ assignments: { [String(p.agent)]: String(p.model ?? 'auto') } as never });

    case 'discover':
      return discover(String(p.provider ?? ''));

    default:
      throw new Error(`MAESTRO: unknown command "${command.command}". Use providers, route, ask, compare, council, setPolicy, assign or discover.`);
  }
}
