import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { REPO_ROOT, DATA_DIR, readJson, writeJson } from '../ide/workspace.js';
import { chat, route as routeModel } from '../llm/index.js';
import { route } from '../core/router.js';
import { AgentIdSchema } from '../types/index.js';

export type Check =
  | { type: 'contains'; value: string }
  | { type: 'not_contains'; value: string }
  | { type: 'regex'; value: string; flags?: string }
  | { type: 'max_latency_ms'; value: number }
  | { type: 'json' }
  | { type: 'judge'; rubric: string };

export interface EvalCase { id: string; input: string; checks: Check[] }
export interface EvalSuite {
  name: string;
  description: string;
  target: { type: 'llm'; system?: string } | { type: 'agent'; agentId: string; command: string };
  cases: EvalCase[];
}

export interface CheckResult { type: string; pass: boolean; detail: string }
export interface CaseResult { id: string; pass: boolean; score: number; latencyMs: number; output: string; checks: CheckResult[]; error?: string; costUsd: number }
export interface ModelResult { model: string; passRate: number; score: number; avgLatencyMs: number; costUsd: number; cases: CaseResult[] }
export interface EvalRun { id: string; suite: string; startedAt: number; endedAt?: number; status: 'running' | 'done' | 'error'; models: string[]; judge?: string; progress: { done: number; total: number }; results: ModelResult[]; error?: string }

const DIR = join(REPO_ROOT, 'evals');
const RUNS_FILE = join(DATA_DIR, 'harness', 'eval-runs.json');
let runs: EvalRun[] = readJson<EvalRun[]>(RUNS_FILE, []).map((r) => (r.status === 'running' ? { ...r, status: 'error', error: 'Interrupted by a server restart' } : r));

function validSuite(s: unknown, file: string): EvalSuite {
  const x = s as EvalSuite;
  if (!x || typeof x.name !== 'string' || !Array.isArray(x.cases) || !x.target) throw new Error(`${file}: needs name, target and cases`);
  for (const c of x.cases) if (!c.id || typeof c.input !== 'string' || !Array.isArray(c.checks)) throw new Error(`${file}: every case needs id, input and checks`);
  return x;
}

export function listSuites(): (EvalSuite & { file: string })[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ ...validSuite(JSON.parse(readFileSync(join(DIR, f), 'utf8')), f), file: f }));
}

async function runCase(suite: EvalSuite, c: EvalCase, model: string, judge: string[]): Promise<CaseResult> {
  const started = Date.now();
  let output = '';
  let costUsd = 0;
  try {
    if (suite.target.type === 'llm') {
      const r = await chat([model], { system: suite.target.system, maxTokens: 4_000, messages: [{ role: 'user', content: c.input }] }, { agent: 'EVAL' });
      output = r.text;
      costUsd = r.costUsd ?? 0;
    } else {
      const agentId = AgentIdSchema.parse(suite.target.agentId.toUpperCase());
      const res = await route({ id: randomUUID(), agentId, command: suite.target.command, params: { message: c.input, prompt: c.input, model }, timestamp: Date.now() }) as Record<string, unknown>;
      output = String(res.response ?? res.summary ?? res.analysis ?? res.answer ?? JSON.stringify(res));
    }
  } catch (err) {
    return { id: c.id, pass: false, score: 0, latencyMs: Date.now() - started, output: '', checks: [], error: err instanceof Error ? err.message : String(err), costUsd };
  }
  const latencyMs = Date.now() - started;
  const checks: CheckResult[] = [];
  for (const ch of c.checks) {
    switch (ch.type) {
      case 'contains': checks.push({ type: 'contains', pass: output.toLowerCase().includes(ch.value.toLowerCase()), detail: `contains "${ch.value}"` }); break;
      case 'not_contains': checks.push({ type: 'not_contains', pass: !output.toLowerCase().includes(ch.value.toLowerCase()), detail: `does not contain "${ch.value}"` }); break;
      case 'regex': { let ok = false; try { ok = new RegExp(ch.value, ch.flags ?? 'i').test(output); } catch { ok = false; } checks.push({ type: 'regex', pass: ok, detail: `matches /${ch.value}/` }); break; }
      case 'max_latency_ms': checks.push({ type: 'max_latency_ms', pass: latencyMs <= ch.value, detail: `${latencyMs} ms ≤ ${ch.value} ms` }); break;
      case 'json': { let ok = true; try { JSON.parse(output.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] ?? output); } catch { ok = false; } checks.push({ type: 'json', pass: ok, detail: 'output contains valid JSON' }); break; }
      case 'judge': {
        try {
          const r = await chat(judge, {
            maxTokens: 600,
            messages: [{ role: 'user', content: `Grade this answer against the rubric. Reply with JSON only: {"pass": true|false, "reason": "one sentence"}.\n\nRUBRIC: ${ch.rubric}\n\nQUESTION: ${c.input}\n\nANSWER: ${output.slice(0, 8_000)}` }],
          }, { agent: 'EVAL' });
          const m = r.text.match(/\{[\s\S]*\}/);
          const v = m ? JSON.parse(m[0]) : null;
          checks.push({ type: 'judge', pass: Boolean(v?.pass), detail: `${ch.rubric} — ${v?.reason ?? r.text.slice(0, 160)} (${r.spec})` });
        } catch (err) {
          checks.push({ type: 'judge', pass: false, detail: `judge failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }
      default: checks.push({ type: String((ch as { type: string }).type), pass: false, detail: 'unknown check type' });
    }
  }
  const passed = checks.filter((x) => x.pass).length;
  return { id: c.id, pass: checks.length > 0 && passed === checks.length, score: checks.length ? passed / checks.length : 0, latencyMs, output: output.slice(0, 4_000), checks, costUsd };
}

export function startEval(suiteName: string, models: string[], judgeModel?: string): EvalRun {
  const suite = listSuites().find((s) => s.name === suiteName || s.file === suiteName);
  if (!suite) throw new Error(`No eval suite named ${suiteName}`);
  if (!models.length) throw new Error('Pick at least one model.');
  if (models.length > 6) throw new Error('Run at most 6 models at once.');
  const judge = judgeModel ? [judgeModel] : routeModel('analyze and evaluate answers', { policy: 'quality' }).chain;
  const run: EvalRun = { id: `eval_${randomUUID().slice(0, 8)}`, suite: suite.name, startedAt: Date.now(), status: 'running', models, judge: judge[0], progress: { done: 0, total: models.length * suite.cases.length }, results: [] };
  runs.unshift(run);
  runs = runs.slice(0, 50);
  writeJson(RUNS_FILE, runs);
  void (async () => {
    try {
      run.results = await Promise.all(models.map(async (model) => {
        const cases: CaseResult[] = [];
        for (const c of suite.cases) {
          cases.push(await runCase(suite, c, model, judge));
          run.progress.done++;
        }
        const n = cases.length || 1;
        return {
          model,
          passRate: Math.round((cases.filter((x) => x.pass).length / n) * 1000) / 10,
          score: Math.round((cases.reduce((t, x) => t + x.score, 0) / n) * 1000) / 10,
          avgLatencyMs: Math.round(cases.reduce((t, x) => t + x.latencyMs, 0) / n),
          costUsd: cases.reduce((t, x) => t + x.costUsd, 0),
          cases,
        };
      }));
      run.status = 'done';
    } catch (err) {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
    }
    run.endedAt = Date.now();
    writeJson(RUNS_FILE, runs);
  })();
  return run;
}

export function evalRuns() { return runs; }
export function evalRun(id: string) { return runs.find((r) => r.id === id); }
