import { randomBytes, randomUUID } from 'crypto';
import { join } from 'path';
import { route } from '../core/router.js';
import { AgentIdSchema } from '../types/index.js';
import { LlmSession, type ChatMessage, type ToolSpec, type ToolResult } from '../llm/index.js';
import { trigger as triggerLindy } from '../integrations/lindy.js';
import { traced } from '../integrations/langsmith.js';
import { DATA_DIR, listFiles, readSrc, readSrcOrEmpty, writeSrc, runTypecheck, readJson, writeJson, safePath } from './workspace.js';

export type TaskStatus = 'running' | 'review' | 'done' | 'error' | 'cancelled';

export interface PlanItem { text: string; done: boolean }
export interface Step { at: number; kind: 'thought' | 'tool' | 'error'; text: string; tool?: string; detail?: string }
export interface EditArtifact {
  id: string;
  kind: 'edit';
  path: string;
  before: string;
  after: string;
  summary: string;
  isNew: boolean;
  state: 'pending' | 'applied' | 'rejected' | 'conflict';
}
export interface NoteArtifact { id: string; kind: 'note'; title: string; body: string }
export type Artifact = EditArtifact | NoteArtifact;

export interface IdeTask {
  id: string;
  prompt: string;
  contextFile?: string;
  autoApply: boolean;
  status: TaskStatus;
  model: string;
  routedTo?: string;
  routeReason?: string;
  modelsUsed?: string[];
  createdAt: number;
  updatedAt: number;
  plan: PlanItem[];
  steps: Step[];
  artifacts: Artifact[];
  summary?: string;
  error?: string;
  tokens: { input: number; output: number };
}

const TASKS_FILE = join(DATA_DIR, 'ide-tasks.json');
const MAX_TASKS = 60;
const MAX_ITER = 18;

const tasks: IdeTask[] = readJson<IdeTask[]>(TASKS_FILE, []).map((t) =>
  t.status === 'running' ? { ...t, status: 'error', error: 'Interrupted by a server restart' } : t,
);
const controllers = new Map<string, AbortController>();
let persistTimer: NodeJS.Timeout | undefined;

export function flushTasks(): void {
  clearTimeout(persistTimer);
  persistTimer = undefined;
  writeJson(TASKS_FILE, tasks.slice(0, MAX_TASKS));
}

function persist(): void {
  if (!persistTimer) persistTimer = setTimeout(flushTasks, 250);
}

process.once('exit', flushTasks);

function touch(t: IdeTask): void {
  t.updatedAt = Date.now();
  persist();
}

function step(t: IdeTask, s: Omit<Step, 'at'>): void {
  t.steps.push({ ...s, at: Date.now() });
  touch(t);
}

const SYSTEM = `You are the coding agent inside Neural Link IDE, working on a TypeScript (CommonJS, Node 20) service that orchestrates 18 AI agents.

How you work:
1. Start by calling update_plan with a short checklist (3 to 7 items) for the request.
2. Investigate with list_files and read_file before changing anything. Read every file you plan to edit.
3. Change code only through propose_edit, always sending the COMPLETE new file content. Match the existing style: ESM-style imports with .js extensions, 2-space indent, single quotes.
4. Mark plan items done with update_plan as you finish them.
5. When you changed TypeScript, call typecheck. Note: proposed edits are not on disk until the user accepts them, so typecheck reports the current disk state.
6. You can run platform agents with dispatch_agent when the request needs their output.
7. Finish with a concise summary: what changed, where, and anything the user should check.

Keep edits focused on the request. Never touch files outside src/.`;

const TOOLS: ToolSpec[] = [
  { name: 'update_plan', description: 'Replace the task plan checklist.', input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text', 'done'] } } }, required: ['items'] } },
  { name: 'list_files', description: 'List every source file under src/ (paths are relative to src/).', input_schema: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'Read a file under src/.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to src/, e.g. agents/TON.ts' } }, required: ['path'] } },
  { name: 'propose_edit', description: 'Propose the complete new content for a .ts file under src/ (new files allowed). The user reviews it as a diff.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'Complete file content' }, summary: { type: 'string', description: 'One sentence describing the change' } }, required: ['path', 'content', 'summary'] } },
  { name: 'typecheck', description: 'Run tsc --noEmit on the project and return errors.', input_schema: { type: 'object', properties: {} } },
  { name: 'trigger_lindy', description: 'Send a JSON payload to the configured Lindy.ai workflow webhook (for emails, CRM updates, scheduling and other Lindy automations).', input_schema: { type: 'object', properties: { payload: { type: 'object' } }, required: ['payload'] } },
  { name: 'dispatch_agent', description: 'Run a platform agent command (ARIA, NEXUS, INFRA, NATURA, ...).', input_schema: { type: 'object', properties: { agentId: { type: 'string' }, command: { type: 'string' }, params: { type: 'object' } }, required: ['agentId', 'command'] } },
];

function short(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

async function runTool(t: IdeTask, name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'update_plan': {
      const items = Array.isArray(input.items) ? input.items : [];
      t.plan = items.map((i: any) => ({ text: String(i?.text ?? ''), done: Boolean(i?.done) })).filter((i) => i.text);
      touch(t);
      return `Plan updated (${t.plan.filter((p) => p.done).length}/${t.plan.length} done).`;
    }
    case 'list_files':
      return listFiles().join('\n');
    case 'read_file': {
      const path = String(input.path ?? '');
      const pending = [...t.artifacts].reverse().find((a): a is EditArtifact => a.kind === 'edit' && a.path === path && a.state === 'pending');
      return pending ? `(showing your pending proposed version)\n${pending.after}` : readSrc(path);
    }
    case 'propose_edit': {
      const path = String(input.path ?? '').replace(/^src\//, '');
      const content = String(input.content ?? '');
      if (!safePath(path) || !path.endsWith('.ts')) throw new Error('Edits must target a .ts file inside src/.');
      const before = readSrcOrEmpty(path);
      const existing = t.artifacts.find((a): a is EditArtifact => a.kind === 'edit' && a.path === path && a.state === 'pending');
      if (existing) {
        existing.after = content;
        existing.summary = String(input.summary ?? existing.summary);
      } else {
        t.artifacts.push({ id: randomUUID(), kind: 'edit', path, before, after: content, summary: String(input.summary ?? ''), isNew: before === '', state: 'pending' });
      }
      touch(t);
      return t.autoApply
        ? `Edit to ${path} recorded. It will be applied automatically when you finish.`
        : `Edit to ${path} recorded for the user's review.`;
    }
    case 'typecheck': {
      const r = await runTypecheck();
      return r.ok ? 'No type errors.' : r.problems.slice(0, 40).map((p) => `${p.file}:${p.line}:${p.col} ${p.code} ${p.message}`).join('\n');
    }
    case 'trigger_lindy':
      return JSON.stringify(await triggerLindy((input.payload as Record<string, unknown>) ?? {})).slice(0, 4_000);
    case 'dispatch_agent': {
      const agentId = AgentIdSchema.parse(String(input.agentId ?? '').toUpperCase());
      const result = await route({ id: randomUUID(), agentId, command: String(input.command ?? ''), params: (input.params as Record<string, unknown>) ?? {}, timestamp: Date.now() });
      return JSON.stringify(result).slice(0, 12_000);
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function applyEdit(t: IdeTask, a: EditArtifact): void {
  const current = readSrcOrEmpty(a.path);
  if (current !== a.before) {
    a.state = 'conflict';
    throw new Error(`${a.path} changed after the agent read it. Ask the agent to redo the edit.`);
  }
  writeSrc(a.path, a.after);
  a.state = 'applied';
  touch(t);
}

function settle(t: IdeTask): void {
  if (t.status === 'running' || t.status === 'cancelled' || t.status === 'error') return;
  t.status = t.artifacts.some((a) => a.kind === 'edit' && a.state === 'pending') ? 'review' : 'done';
}

async function execute(t: IdeTask): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(t.id, ctrl);
  const intro = t.contextFile ? `The user has src/${t.contextFile} open in the editor.\n\n` : '';
  const messages: ChatMessage[] = [{ role: 'user', content: `${intro}${t.prompt}` }];
  try {
    const session = new LlmSession('IDE', `code ${t.prompt}`, t.model);
    t.routeReason = session.decision.reason;
    t.routedTo = session.decision.spec;
    touch(t);
    for (let i = 0; i < MAX_ITER; i++) {
      if (ctrl.signal.aborted) throw new Error('Cancelled');
      const res = await session.turn({ system: SYSTEM, tools: TOOLS, messages, maxTokens: 16_000, signal: ctrl.signal });
      for (const a of res.attempts.filter((x) => !x.ok)) step(t, { kind: 'error', text: `Fell back from ${a.spec}`, detail: a.error });
      t.routedTo = res.spec;
      t.modelsUsed = [...session.used];
      t.tokens.input += res.usage.input;
      t.tokens.output += res.usage.output;
      if (res.stop !== 'tool_use' || !res.toolCalls.length) {
        t.summary = res.text || 'Finished.';
        break;
      }
      if (res.text) step(t, { kind: 'thought', text: short(res.text, 400) });
      messages.push(res.assistant);
      const results: ToolResult[] = [];
      for (const call of res.toolCalls) {
        const input = call.input;
        const label = call.name === 'read_file' || call.name === 'propose_edit' ? `${call.name} ${String(input.path ?? '')}`
          : call.name === 'dispatch_agent' ? `dispatch_agent ${String(input.agentId ?? '')}.${String(input.command ?? '')}` : call.name;
        try {
          const out = await traced(call.name, 'tool', input, () => runTool(t, call.name, input), { outputs: (o) => ({ output: o }) });
          if (call.name !== 'update_plan') step(t, { kind: 'tool', tool: call.name, text: label, detail: short(out, 240) });
          results.push({ id: call.id, name: call.name, content: out });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          step(t, { kind: 'error', tool: call.name, text: `${label} failed`, detail: msg });
          results.push({ id: call.id, name: call.name, content: msg, isError: true });
        }
      }
      messages.push({ role: 'tool', results });
      if (i === MAX_ITER - 1) t.summary = res.text || `Stopped after ${MAX_ITER} steps.`;
    }
    if (t.autoApply) {
      for (const a of t.artifacts) {
        if (a.kind !== 'edit' || a.state !== 'pending') continue;
        try { applyEdit(t, a); } catch (err) { step(t, { kind: 'error', text: `Could not apply ${a.path}`, detail: err instanceof Error ? err.message : String(err) }); }
      }
    }
    t.status = 'done';
    settle(t);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    t.status = ctrl.signal.aborted ? 'cancelled' : 'error';
    t.error = ctrl.signal.aborted ? undefined : msg;
    if (!ctrl.signal.aborted) step(t, { kind: 'error', text: 'Task failed', detail: msg });
  } finally {
    controllers.delete(t.id);
    touch(t);
  }
}

export function createTask(prompt: string, opts: { contextFile?: string; autoApply?: boolean; model?: string }): IdeTask {
  if (!prompt.trim()) throw new Error('Describe what the agent should do.');
  const t: IdeTask = {
    id: `task_${randomBytes(4).toString('hex')}`,
    prompt: prompt.trim(),
    contextFile: opts.contextFile && safePath(opts.contextFile) ? opts.contextFile : undefined,
    autoApply: Boolean(opts.autoApply),
    status: 'running',
    model: typeof opts.model === 'string' && opts.model ? opts.model : 'auto',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: [],
    steps: [],
    artifacts: [],
    tokens: { input: 0, output: 0 },
  };
  tasks.unshift(t);
  if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
  persist();
  void traced('IDE agent task', 'chain', { prompt: t.prompt, contextFile: t.contextFile, model: t.model }, () => execute(t).then(() => t), {
    metadata: { task: t.id },
    outputs: (x) => ({ status: x.status, summary: x.summary, edits: x.artifacts.filter((a) => a.kind === 'edit').map((a) => (a as EditArtifact).path) }),
  }).catch(() => undefined);
  return t;
}

export function listTasks() {
  return tasks.map(({ steps, artifacts, ...rest }) => ({
    ...rest,
    stepCount: steps.length,
    edits: artifacts.filter((a) => a.kind === 'edit').map((a) => ({ id: a.id, path: (a as EditArtifact).path, state: (a as EditArtifact).state })),
  }));
}

export function getTask(id: string): IdeTask | undefined {
  return tasks.find((t) => t.id === id);
}

export function cancelTask(id: string): IdeTask {
  const t = getTask(id);
  if (!t) throw new Error('Task not found');
  controllers.get(id)?.abort();
  return t;
}

export function resolveEdit(id: string, artifactId: string, accept: boolean): IdeTask {
  const t = getTask(id);
  if (!t) throw new Error('Task not found');
  const a = t.artifacts.find((x): x is EditArtifact => x.id === artifactId && x.kind === 'edit');
  if (!a) throw new Error('Edit not found');
  if (a.state !== 'pending') throw new Error(`This edit was already ${a.state}`);
  if (accept) applyEdit(t, a);
  else { a.state = 'rejected'; touch(t); }
  settle(t);
  touch(t);
  return t;
}

export function deleteTask(id: string): void {
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) throw new Error('Task not found');
  controllers.get(id)?.abort();
  tasks.splice(i, 1);
  persist();
}
