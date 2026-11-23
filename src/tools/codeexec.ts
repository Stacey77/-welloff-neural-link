import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '../ide/workspace.js';
import { route } from '../core/router.js';
import { AgentIdSchema } from '../types/index.js';
import { emit } from '../security/events.js';
import { getPolicy, toolAllowed } from '../security/guardrails.js';
import { searchTools, runMetaTool } from './progressive.js';
import type { ToolSpec } from '../llm/index.js';

// Model-written JavaScript runs in a child process started with Node's permission model
// (no file system access beyond the runner, no child processes or workers), an empty
// environment, a memory cap and a timeout. Inside it, code runs in a vm context whose only
// link to the host is a prototype-less bridge function. It is a strong restriction, not a
// hardened sandbox, so it stays off until enabled in Security → Guardrails.

const RUNNER = `'use strict';
const vm = require('vm');
const readline = require('readline');
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) { try { delete globalThis[k]; } catch {} }
const pending = new Map();
let deliver = null;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
function bridge(kind, id, payload) {
  if (typeof kind !== 'string' || typeof id !== 'string' || typeof payload !== 'string') return;
  out({ type: kind, id, payload });
}
Object.setPrototypeOf(bridge, null);
const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
ctx.__bridge = bridge;
vm.runInContext(\`'use strict';
(() => {
  const b = globalThis.__bridge; delete globalThis.__bridge;
  const waits = new Map(); let n = 0;
  const call = (kind, payload) => new Promise((resolve, reject) => {
    const id = String(++n); waits.set(id, { resolve, reject }); b(kind, id, JSON.stringify(payload));
  });
  globalThis.__deliver = (id, ok, json) => { const w = waits.get(id); if (!w) return; waits.delete(id); ok ? w.resolve(JSON.parse(json)) : w.reject(new Error(JSON.parse(json))); };
  const fmt = (a) => a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  globalThis.console = Object.freeze({ log: (...a) => b('log', '0', fmt(a)), error: (...a) => b('log', '0', fmt(a)) });
  globalThis.tools = Object.freeze({
    search: (query, limit) => call('search', { query, limit }),
    call: (name, args) => call('call', { name, args: args || {} }),
    agent: (agentId, command, params) => call('agent', { agentId, command, params: params || {} }),
    skill: (name) => call('skill', { name }),
  });
})();\`, ctx);
deliver = ctx.__deliver; delete ctx.__deliver;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'run') {
    let p;
    try { p = vm.runInContext('(async () => {\\n' + m.code + '\\n})()', ctx, { timeout: 2000, filename: 'agent-code.js' }); }
    catch (e) { out({ type: 'done', ok: false, error: String(e && e.message || e) }); return; }
    Promise.resolve(p).then(
      (v) => { let s; try { s = JSON.stringify(v === undefined ? null : v); } catch { s = JSON.stringify(String(v)); } out({ type: 'done', ok: true, value: s }); },
      (e) => out({ type: 'done', ok: false, error: String(e && e.message || e) }),
    );
  } else if (m.type === 'result') {
    deliver(String(m.id), !!m.ok, String(m.json));
  }
});
`;

let runnerPath: string | null = null;
function ensureRunner(): string {
  if (runnerPath) return runnerPath;
  const dir = join(DATA_DIR, 'runner');
  mkdirSync(dir, { recursive: true });
  runnerPath = join(dir, 'code-runner.js');
  writeFileSync(runnerPath, RUNNER, 'utf8');
  return runnerPath;
}

export const RUN_CODE_TOOL: ToolSpec = {
  name: 'run_code',
  description: 'Run JavaScript to do multi-step work with tools in one go; only what you return (and console.log output) comes back, so filter and summarize inside the code. Available: await tools.search(query, limit) → tool definitions; await tools.call(name, args) → tool result; await tools.agent(agentId, command, params) → run a platform agent; await tools.skill(name) → skill text. Top-level await works. No file system, network or require.',
  input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
};

const MAX_OUT = 20_000;

export async function runCode(code: string, actor: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; value?: unknown; error?: string; logs: string[]; calls: number; ms: number }> {
  if (!getPolicy().codeExecution) throw new Error('Code execution is turned off. Enable it in Security → Guardrails.');
  if (code.length > 50_000) throw new Error('Code is longer than 50,000 characters.');
  const started = Date.now();
  const runner = ensureRunner();
  const major = Number(process.versions.node.split('.')[0]);
  const permFlag = major >= 22 ? '--permission' : '--experimental-permission';
  const child = spawn(process.execPath, [permFlag, `--allow-fs-read=${runner}`, '--max-old-space-size=128', runner], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const logs: string[] = [];
  let calls = 0;
  const runId = randomUUID().slice(0, 8);
  emit({ kind: 'code_exec', severity: 'low', actor, source: 'run_code', summary: `${actor} ran ${code.split('\n').length} line(s) of code`, action: 'logged', details: { runId, preview: code.slice(0, 300) } });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; value?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ ...r, logs: logs.slice(0, 200), calls, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `Timed out after ${(opts.timeoutMs ?? 30_000) / 1000}s` }), opts.timeoutMs ?? 30_000);
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    const reply = (id: string, ok: boolean, v: unknown) => {
      let json = JSON.stringify(v ?? null);
      if (json.length > 200_000) json = JSON.stringify({ truncated: true, preview: json.slice(0, 200_000) });
      send({ type: 'result', id, ok, json });
    };
    let buf = '';
    child.stdout.on('data', async (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'log') { if (logs.length < 500) logs.push(String(m.payload).slice(0, 2_000)); continue; }
        if (m.type === 'done') {
          let value: unknown = null;
          try { value = m.ok ? JSON.parse(m.value) : undefined; } catch { value = m.value; }
          const s = JSON.stringify(value ?? null);
          finish(m.ok ? { ok: true, value: s.length > MAX_OUT ? { truncated: true, preview: s.slice(0, MAX_OUT) } : value } : { ok: false, error: m.error });
          continue;
        }
        if (++calls > 200) { finish({ ok: false, error: 'More than 200 tool calls in one run.' }); return; }
        let payload: any = {};
        try { payload = JSON.parse(m.payload); } catch { /* reply with error below */ }
        try {
          if (m.type === 'search') reply(m.id, true, await searchTools(String(payload.query ?? ''), Math.min(15, Number(payload.limit) || 6)));
          else if (m.type === 'call') {
            if (!toolAllowed(actor, String(payload.name))) throw new Error(`Tool ${payload.name} is denied by policy.`);
            reply(m.id, true, await runMetaTool('call_tool', { name: payload.name, args: payload.args }));
          } else if (m.type === 'agent') {
            const agentId = AgentIdSchema.parse(String(payload.agentId ?? '').toUpperCase());
            if (!toolAllowed(actor, `agent:${agentId}`)) throw new Error(`Agent ${agentId} is denied by policy.`);
            reply(m.id, true, await route({ id: randomUUID(), agentId, command: String(payload.command ?? ''), params: payload.params ?? {}, timestamp: Date.now() }));
          } else if (m.type === 'skill') reply(m.id, true, await runMetaTool('load_skill', { name: payload.name }));
          else reply(m.id, false, `Unknown bridge call ${m.type}`);
        } catch (err) {
          reply(m.id, false, err instanceof Error ? err.message : String(err));
        }
      }
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => finish({ ok: false, error: `Runner exited (${code})${stderr ? `: ${stderr.slice(0, 300)}` : ''}` }));
    send({ type: 'run', code });
  });
}
