import { callMcpTool } from '../connectors/mcp-client.js';
import type { ToolSpec } from '../llm/index.js';
import { getPolicy } from '../security/guardrails.js';
import { allTools, isMetaTool, META_TOOLS, runMetaTool } from './progressive.js';
import { RUN_CODE_TOOL, runCode } from './codeexec.js';

export type ToolAccess = 'full' | 'progressive' | 'code';

export function accessMode(): ToolAccess {
  const p = getPolicy();
  return p.toolAccess === 'code' && !p.codeExecution ? 'progressive' : p.toolAccess;
}

export async function platformTools(): Promise<ToolSpec[]> {
  const mode = accessMode();
  if (mode === 'full') return [...(await allTools()), ...META_TOOLS.filter((t) => t.name.endsWith('_skill') || t.name === 'list_skills')];
  return mode === 'code' ? [...META_TOOLS, RUN_CODE_TOOL] : META_TOOLS;
}

export function handlesTool(name: string): boolean {
  return isMetaTool(name) || name === 'run_code';
}

export async function runPlatformTool(name: string, input: Record<string, unknown>, actor: string): Promise<unknown> {
  if (name === 'run_code') return runCode(String(input.code ?? ''), actor);
  if (isMetaTool(name)) return runMetaTool(name, input);
  return callMcpTool(name, input);
}
