import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { REPO_ROOT, SRC_ROOT, listFiles } from '../ide/workspace.js';
import { registeredAgents } from '../core/router.js';
import { describe as describeLlm } from '../llm/index.js';
import { getSettings } from '../llm/settings.js';
import { envValue } from '../llm/catalog.js';
import { langsmithStatus } from '../integrations/langsmith.js';
import { lindyStatus } from '../integrations/lindy.js';
import { scan } from './detectors.js';
import { getPolicy } from './guardrails.js';
import { emit, queryEvents } from './events.js';

export interface Finding { id: string; severity: 'low' | 'medium' | 'high' | 'critical'; title: string; detail: string; fix: string }

function gitTracked(path: string): Promise<boolean> {
  return new Promise((ok) => execFile('git', ['ls-files', '--error-unmatch', path], { cwd: REPO_ROOT }, (err) => ok(!err)));
}

export async function inventory() {
  const registered = new Set(registeredAgents());
  const agentDir = join(SRC_ROOT, 'agents');
  const files = existsSync(agentDir) ? readdirSync(agentDir).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')) : [];
  const llmUsers = new Set(Object.keys(getSettings().assignments));
  const agents = files.map((id) => {
    const src = readFileSync(join(agentDir, `${id}.ts`), 'utf8');
    return {
      id,
      registered: registered.has(id),
      callsLlm: /from '\.\.\/llm\/index\.js'|LlmSession|\bask\(/.test(src) || llmUsers.has(id),
      callsTools: /callMcpTool|dispatch_agent|route\(/.test(src),
      writesFiles: /writeFileSync|writeSrc/.test(src),
      network: /fetch\(|trigger\(/.test(src),
      model: getSettings().assignments[id as keyof ReturnType<typeof getSettings>['assignments']] ?? null,
    };
  });
  const llm = await describeLlm();
  const ls = langsmithStatus();
  const ld = lindyStatus();
  const policy = getPolicy();
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  for (const a of agents.filter((x) => !x.registered)) {
    add({ id: `hidden:${a.id}`, severity: a.writesFiles || a.network ? 'high' : 'medium', title: `Unregistered agent file: ${a.id}`, detail: `src/agents/${a.id}.ts exists but is not in the router, so nothing reviews or monitors it. GENESIS-generated agents land here.`, fix: 'Review the file, then register it in src/core/router.ts or delete it.' });
  }
  for (const id of registered) if (!files.includes(id)) add({ id: `ghost:${id}`, severity: 'low', title: `Registered agent without a file: ${id}`, detail: 'The router references an agent whose source file is missing.', fix: 'Remove it from the router.' });

  const keySet = Boolean(process.env.NEURAL_API_KEY);
  if (!keySet) add({ id: 'no_api_key', severity: 'medium', title: 'Agent endpoints have no API key', detail: '/dispatch, /ton, /brain and /workflow accept any caller that can reach the port.', fix: 'Set NEURAL_API_KEY.' });
  if (ls.enabled) add({ id: 'langsmith_flow', severity: policy.secret === 'off' ? 'high' : 'low', title: 'Prompts are sent to LangSmith', detail: `Traces include prompts and tool results for project ${ls.project}. ${policy.secret === 'off' ? 'Secret redaction is off.' : 'Secrets are redacted before tracing.'}`, fix: policy.secret === 'off' ? 'Turn secret redaction on in Guardrails.' : 'Keep PII redaction on if traces may include customer data.' });
  const external = llm.providers.filter((p) => p.configured && !p.local).map((p) => p.label);
  if (external.length) add({ id: 'external_llms', severity: 'low', title: `Data is sent to ${external.length} external model provider(s)`, detail: external.join(', '), fix: policy.pii === 'redact' ? 'PII is redacted before leaving.' : 'Set PII to redact if prompts may contain customer data.' });
  if (policy.codeExecution) add({ id: 'code_exec_on', severity: 'medium', title: 'Agent code execution is on', detail: 'Agents can run model-written JavaScript in a restricted child process (no file system or child processes; not a hardened sandbox).', fix: 'Turn it off unless you use the code tool-access mode.' });
  if (policy.injection === 'off' || policy.injection === 'monitor') add({ id: 'injection_weak', severity: 'medium', title: 'Prompt-injection defence is not enforcing', detail: `Mode is ${policy.injection}.`, fix: 'Use quarantine or block.' });

  if (existsSync(join(REPO_ROOT, '.env')) && await gitTracked('.env')) add({ id: 'env_tracked', severity: 'critical', title: '.env is committed to git', detail: 'Your API keys are in the repository history.', fix: 'Rotate every key in .env, then git rm --cached .env.' });

  const secretHits: { file: string; line: number; type: string; preview: string }[] = [];
  for (const rel of listFiles()) {
    const text = readFileSync(join(SRC_ROOT, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
      if (ln.length > 2_000) return;
      for (const f of scan(ln, ['secret'])) secretHits.push({ file: `src/${rel}`, line: i + 1, type: f.type, preview: f.preview });
    });
  }
  for (const h of secretHits.slice(0, 20)) add({ id: `secret:${h.file}:${h.line}`, severity: 'high', title: `Possible secret in ${h.file}:${h.line}`, detail: `${h.type.replace(/_/g, ' ')}: ${h.preview}`, fix: 'Move it to .env and rotate it if it was ever committed.' });

  for (const f of findings.filter((x) => x.id.startsWith('hidden:'))) {
    const recent = queryEvents({ kind: 'hidden_agent', since: Date.now() - 86_400_000 }).some((e) => e.details?.id === f.id);
    if (!recent) emit({ kind: 'hidden_agent', severity: f.severity, actor: 'inventory', source: 'discovery', summary: f.title, action: 'logged', details: { id: f.id } });
  }

  const rank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
  findings.sort((a, b) => rank[b.severity] - rank[a.severity]);
  const penalty = findings.reduce((t, f) => t + ({ critical: 25, high: 12, medium: 5, low: 1 } as const)[f.severity], 0);
  return {
    score: Math.max(0, 100 - penalty),
    agents,
    providers: llm.providers.map((p) => ({ id: p.id, label: p.label, configured: p.configured, local: p.local })),
    integrations: { langsmith: ls.enabled, lindyOut: ld.outbound, lindyIn: ld.inbound },
    endpoints: [
      { path: '/dispatch, /ton, /brain, /workflow', guarded: keySet ? 'NEURAL_API_KEY' : 'open' },
      { path: '/v1 (OpenAI-compatible gateway)', guarded: keySet ? 'NEURAL_API_KEY' : 'localhost only' },
      { path: '/ide/api', guarded: keySet ? 'NEURAL_API_KEY + same origin' : 'localhost + same origin' },
      { path: '/integrations/lindy', guarded: envValue('LINDY_INBOUND_SECRET') ? 'shared secret' : 'disabled' },
      { path: '/assistant/events', guarded: envValue('ASSISTANT_WEBHOOK_SECRET') ? 'shared secret' : 'disabled' },
    ],
    findings,
  };
}
