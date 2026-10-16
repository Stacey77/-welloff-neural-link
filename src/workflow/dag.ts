import { randomUUID } from 'crypto';
import { route } from '../core/router.js';
import type { AgentId } from '../types/index.js';

export interface DagStep {
  id: string;
  agentId: AgentId;
  command: string;
  params?: Record<string, unknown>;
  dependsOn?: string[];
  label?: string;
}

export interface DagResult {
  stepId: string;
  agentId: AgentId;
  label?: string;
  status: 'success' | 'error' | 'skipped';
  result?: unknown;
  error?: string;
  latencyMs: number;
}

export interface DagPlan {
  id?: string;
  description?: string;
  steps: DagStep[];
}

export interface DagExecution {
  planId: string;
  description?: string;
  results: Record<string, DagResult>;
  status: 'complete' | 'partial' | 'failed';
  totalSteps: number;
  succeededSteps: number;
  failedSteps: number;
  startedAt: number;
  completedAt: number;
  totalLatencyMs: number;
}

async function executeStep(step: DagStep, priorResults: Record<string, DagResult>): Promise<DagResult> {
  const start = Date.now();
  // Inject results of dependencies into params
  const enrichedParams: Record<string, unknown> = { ...step.params };
  if (step.dependsOn?.length) {
    enrichedParams._dependencyResults = Object.fromEntries(
      step.dependsOn.map(depId => [depId, priorResults[depId]?.result])
    );
  }
  try {
    const result = await route({
      id: randomUUID(),
      agentId: step.agentId,
      command: step.command,
      params: enrichedParams,
      timestamp: Date.now(),
    });
    return { stepId: step.id, agentId: step.agentId, label: step.label, status: 'success', result, latencyMs: Date.now() - start };
  } catch (err) {
    return { stepId: step.id, agentId: step.agentId, label: step.label, status: 'error', error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

export async function executeDag(plan: DagPlan): Promise<DagExecution> {
  const planId = plan.id ?? randomUUID();
  const startedAt = Date.now();
  const results: Record<string, DagResult> = {};
  const completed = new Set<string>();
  const remaining = new Map(plan.steps.map(s => [s.id, s]));

  // Topological execution: keep launching steps whose dependencies are met
  while (remaining.size > 0) {
    // Find all steps that are ready (all deps completed)
    const ready = [...remaining.values()].filter(step => {
      const deps = step.dependsOn ?? [];
      return deps.every(dep => completed.has(dep));
    });

    if (ready.length === 0) {
      // Deadlock or all remaining have failed deps — skip them
      for (const step of remaining.values()) {
        results[step.id] = { stepId: step.id, agentId: step.agentId, label: step.label, status: 'skipped', latencyMs: 0 };
        completed.add(step.id);
        remaining.delete(step.id);
      }
      break;
    }

    // Execute all ready steps in parallel
    const settled = await Promise.allSettled(ready.map(step => executeStep(step, results)));

    for (let i = 0; i < ready.length; i++) {
      const step = ready[i];
      const outcome = settled[i];
      const result = outcome.status === 'fulfilled' ? outcome.value : {
        stepId: step.id, agentId: step.agentId, label: step.label, status: 'error' as const,
        error: outcome.reason?.message ?? String(outcome.reason), latencyMs: 0,
      };
      results[step.id] = result;
      completed.add(step.id);
      remaining.delete(step.id);
    }
  }

  const stepResults = Object.values(results);
  const succeededSteps = stepResults.filter(r => r.status === 'success').length;
  const failedSteps = stepResults.filter(r => r.status === 'error').length;

  return {
    planId,
    description: plan.description,
    results,
    status: failedSteps === 0 ? 'complete' : succeededSteps > 0 ? 'partial' : 'failed',
    totalSteps: plan.steps.length,
    succeededSteps,
    failedSteps,
    startedAt,
    completedAt: Date.now(),
    totalLatencyMs: Date.now() - startedAt,
  };
}
