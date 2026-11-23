import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { envValue } from '../llm/catalog.js';

type RunType = 'chain' | 'llm' | 'tool';
interface RunCtx { id: string; traceId: string; dottedOrder: string }

const als = new AsyncLocalStorage<RunCtx>();
const status = { sent: 0, failed: 0, lastError: '' as string, lastTraceAt: 0 };

function apiKey(): string | undefined {
  return envValue('LANGSMITH_API_KEY') ?? envValue('LANGCHAIN_API_KEY');
}

export function langsmithEnabled(): boolean {
  const flag = (envValue('LANGSMITH_TRACING') ?? envValue('LANGCHAIN_TRACING_V2') ?? 'true').toLowerCase();
  return Boolean(apiKey()) && flag !== 'false';
}

function endpoint(): string {
  return (envValue('LANGSMITH_ENDPOINT') ?? envValue('LANGCHAIN_ENDPOINT') ?? 'https://api.smith.langchain.com').replace(/\/$/, '');
}

export function projectName(): string {
  return envValue('LANGSMITH_PROJECT') ?? envValue('LANGCHAIN_PROJECT') ?? 'neural-link';
}

export function langsmithStatus() {
  return { enabled: langsmithEnabled(), project: projectName(), endpoint: endpoint(), ...status };
}

// LangSmith orders runs in a trace by dotted_order: <start time to the microsecond>Z<run id>, joined by dots from the root.
function stamp(d: Date, id: string): string {
  const iso = d.toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${iso.slice(0, 15)}${iso.slice(15, 18)}000Z${id}`;
}

function clip(value: unknown, max = 24_000): unknown {
  const s = JSON.stringify(value ?? null);
  return s.length <= max ? value : { truncated: true, preview: s.slice(0, max) };
}

async function send(method: 'POST' | 'PATCH', path: string, body: object): Promise<void> {
  try {
    const r = await fetch(`${endpoint()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey() ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`LangSmith ${r.status}: ${(await r.text()).slice(0, 200)}`);
    status.sent++;
  } catch (err) {
    status.failed++;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== status.lastError) console.error('[langsmith]', msg);
    status.lastError = msg;
  }
}

export interface TraceOptions<T> {
  metadata?: Record<string, unknown>;
  outputs?: (result: T) => Record<string, unknown>;
}

export async function traced<T>(name: string, runType: RunType, inputs: Record<string, unknown>, fn: () => Promise<T>, opts: TraceOptions<T> = {}): Promise<T> {
  if (!langsmithEnabled()) return fn();
  const id = randomUUID();
  const start = new Date();
  const parent = als.getStore();
  const traceId = parent?.traceId ?? id;
  const dottedOrder = `${parent ? `${parent.dottedOrder}.` : ''}${stamp(start, id)}`;
  status.lastTraceAt = Date.now();
  const created = send('POST', '/runs', {
    id, name, run_type: runType, inputs: clip(inputs), start_time: start.toISOString(),
    trace_id: traceId, dotted_order: dottedOrder, ...(parent ? { parent_run_id: parent.id } : {}),
    session_name: projectName(), extra: { metadata: { app: 'neural-link', ...opts.metadata } },
  });
  try {
    const result = await als.run({ id, traceId, dottedOrder }, fn);
    void created.then(() => send('PATCH', `/runs/${id}`, {
      end_time: new Date().toISOString(),
      outputs: clip(opts.outputs ? opts.outputs(result) : { output: result }),
    }));
    return result;
  } catch (err) {
    void created.then(() => send('PATCH', `/runs/${id}`, { end_time: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }));
    throw err;
  }
}
