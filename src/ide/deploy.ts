import { spawn, type ChildProcess } from 'child_process';
import { cpSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { createServer, request as httpRequest, type Server } from 'http';
import { connect as netConnect, createServer as netServer } from 'net';
import { createHash, randomBytes } from 'crypto';
import { REPO_ROOT, TSC_BIN, gitInfo, readJson, writeJson } from './workspace.js';
import { readEnvFile } from './env.js';
import { buildStaticSite } from './static-site.js';

export type Provider = 'local' | 'netlify' | 'vercel';
export type Target = 'preview' | 'production';
export type DeployState = 'queued' | 'building' | 'deploying' | 'ready' | 'error' | 'stopped' | 'cancelled';

export interface LogLine { t: number; level: 'info' | 'warn' | 'error'; src: 'build' | 'runtime'; msg: string }

export interface Deployment {
  id: string;
  provider: Provider;
  target: Target;
  state: DeployState;
  createdAt: number;
  readyAt?: number;
  buildMs?: number;
  url?: string;
  port?: number;
  isProduction: boolean;
  commit: { sha: string; message: string; dirty: boolean };
  error?: string;
  logs: LogLine[];
}

const DEPLOY_ROOT = join(REPO_ROOT, '.deployments');
const INDEX_FILE = join(DEPLOY_ROOT, 'index.json');
const PROVIDERS_FILE = join(DEPLOY_ROOT, 'providers.json');
export const PROD_PORT = Number(process.env.NL_PROD_PORT ?? 4000);
const MAX_LOGS = 1500;
const MAX_DEPLOYMENTS = 30;

const deployments: Deployment[] = readJson<Deployment[]>(INDEX_FILE, []).map((d) =>
  ['queued', 'building', 'deploying'].includes(d.state)
    ? { ...d, state: 'error', error: 'Interrupted by a server restart' }
    : d.provider === 'local' && d.state === 'ready'
      ? { ...d, state: 'stopped' }
      : d,
);
const procs = new Map<string, ChildProcess>();
const cancelled = new Set<string>();
let persistTimer: NodeJS.Timeout | undefined;

function flush(): void {
  clearTimeout(persistTimer);
  persistTimer = undefined;
  writeJson(INDEX_FILE, deployments.map((d) => ({ ...d, logs: d.logs.slice(-300) })));
}

function persist(): void {
  if (!persistTimer) persistTimer = setTimeout(flush, 300);
}

function log(d: Deployment, msg: string, level: LogLine['level'] = 'info', src: LogLine['src'] = 'build'): void {
  for (const line of msg.split(/\r?\n/)) {
    if (!line.trim()) continue;
    d.logs.push({ t: Date.now(), level, src, msg: line });
  }
  if (d.logs.length > MAX_LOGS) d.logs.splice(0, d.logs.length - MAX_LOGS);
  persist();
}

function env(name: string): string | undefined {
  return process.env[name] || readEnvFile()[name] || undefined;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = netServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

function runStep(d: Deployment, args: string[], cwd: string): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.set(d.id, child);
    child.stdout.on('data', (b: Buffer) => log(d, b.toString()));
    child.stderr.on('data', (b: Buffer) => log(d, b.toString(), 'error'));
    child.on('exit', (code) => {
      procs.delete(d.id);
      if (cancelled.has(d.id)) fail(new Error('Cancelled'));
      else if (code === 0) ok();
      else fail(new Error(`Build failed with exit code ${code}`));
    });
  });
}

function deployDir(d: Deployment): string {
  return join(DEPLOY_ROOT, d.id);
}

async function startLocal(d: Deployment): Promise<void> {
  const dir = deployDir(d);
  if (!existsSync(join(dir, 'dist/index.js'))) throw new Error('Build output is missing. Redeploy to rebuild it.');
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...readEnvFile(),
    PORT: String(port),
    NL_DEPLOYMENT_ID: d.id,
    NL_SCHEDULER: d.target === 'production' ? 'on' : 'off',
  };
  log(d, `Starting server on port ${port}`);
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.set(d.id, child);
  child.stdout.on('data', (b: Buffer) => log(d, b.toString(), 'info', 'runtime'));
  child.stderr.on('data', (b: Buffer) => log(d, b.toString(), 'error', 'runtime'));
  child.on('exit', (code, signal) => {
    procs.delete(d.id);
    log(d, `Server exited (${signal ?? `code ${code}`})`, code === 0 || signal ? 'info' : 'error', 'runtime');
    if (d.state === 'ready' || d.state === 'deploying') {
      d.state = d.state === 'deploying' ? 'error' : 'stopped';
      d.port = undefined;
      persist();
    }
  });
  if (!(await waitHealthy(port, 25_000))) {
    child.kill();
    throw new Error('The server did not pass its health check within 25s');
  }
  d.port = port;
  d.url = `http://localhost:${port}`;
  d.state = 'ready';
  log(d, `Health check passed · ${d.url}`);
  persist();
}

async function runLocal(d: Deployment): Promise<void> {
  const dir = deployDir(d);
  log(d, 'Cloning workspace snapshot');
  mkdirSync(dir, { recursive: true });
  for (const f of ['src', 'package.json', 'tsconfig.json', 'ide.html', 'index.html']) {
    const from = join(REPO_ROOT, f);
    if (existsSync(from)) cpSync(from, join(dir, f), { recursive: true });
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  log(d, 'Reusing installed dependencies');
  log(d, 'Running build: tsc -p tsconfig.json');
  const started = Date.now();
  await runStep(d, [TSC_BIN, '-p', 'tsconfig.json', '--pretty', 'false'], dir);
  d.buildMs = Date.now() - started;
  log(d, `Build completed in ${(d.buildMs / 1000).toFixed(1)}s`);
  d.state = 'deploying';
  persist();
  await startLocal(d);
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

async function jsonFetch(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) throw new Error(`${res.status} ${body?.message ?? body?.error?.message ?? text}`.slice(0, 400));
  return body;
}

async function runNetlify(d: Deployment): Promise<void> {
  const token = env('NETLIFY_AUTH_TOKEN');
  if (!token) throw new Error('Add NETLIFY_AUTH_TOKEN under Environment variables to deploy to Netlify.');
  const auth = { Authorization: `Bearer ${token}` };
  const api = 'https://api.netlify.com/api/v1';
  const providers = readJson<Record<string, string>>(PROVIDERS_FILE, {});
  let siteId = env('NETLIFY_SITE_ID') ?? providers.netlifySiteId;
  if (!siteId) {
    log(d, 'Creating a Netlify site');
    const site = await jsonFetch(`${api}/sites`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    siteId = site.id as string;
    writeJson(PROVIDERS_FILE, { ...providers, netlifySiteId: siteId });
    log(d, `Created site ${site.name}`);
  }
  log(d, 'Bundling static frontend (IDE + dashboard)');
  const files = buildStaticSite();
  const digests = Object.fromEntries(Object.entries(files).map(([p, c]) => [`/${p}`, sha1(c)]));
  const dep = await jsonFetch(`${api}/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: digests, draft: d.target !== 'production' }),
  });
  d.state = 'deploying';
  const required: string[] = dep.required ?? [];
  log(d, `Uploading ${required.length} of ${Object.keys(digests).length} files`);
  for (const sha of required) {
    const path = Object.keys(digests).find((k) => digests[k] === sha);
    if (!path) continue;
    const encoded = path.slice(1).split('/').map(encodeURIComponent).join('/');
    await jsonFetch(`${api}/deploys/${dep.id}/files/${encoded}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: files[path.slice(1)],
    });
    log(d, `Uploaded ${path}`);
  }
  for (let i = 0; i < 90; i++) {
    const s = await jsonFetch(`${api}/deploys/${dep.id}`, { headers: auth });
    if (s.state === 'ready') {
      d.url = d.target === 'production' ? s.ssl_url || s.url : s.deploy_ssl_url || s.deploy_url;
      d.state = 'ready';
      log(d, `Netlify deploy is live · ${d.url}`);
      return;
    }
    if (s.state === 'error') throw new Error(s.error_message || 'Netlify reported an error');
    if (cancelled.has(d.id)) throw new Error('Cancelled');
    await sleep(2000);
  }
  throw new Error('Timed out waiting for Netlify');
}

async function runVercel(d: Deployment): Promise<void> {
  const token = env('VERCEL_TOKEN');
  if (!token) throw new Error('Add VERCEL_TOKEN under Environment variables to deploy to Vercel.');
  const team = env('VERCEL_TEAM_ID');
  const q = team ? `?teamId=${encodeURIComponent(team)}` : '';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  log(d, 'Bundling static frontend (IDE + dashboard)');
  const files = Object.entries(buildStaticSite()).map(([file, data]) => ({ file, data }));
  const created = await jsonFetch(`https://api.vercel.com/v13/deployments${q}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: env('VERCEL_PROJECT') ?? 'neural-link-ide',
      files,
      projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
      ...(d.target === 'production' ? { target: 'production' } : {}),
    }),
  });
  d.state = 'deploying';
  log(d, `Vercel deployment ${created.id} created`);
  for (let i = 0; i < 90; i++) {
    const s = await jsonFetch(`https://api.vercel.com/v13/deployments/${created.id}${q}`, { headers });
    if (s.readyState === 'READY') {
      const host = d.target === 'production' && s.alias?.length ? s.alias[0] : s.url;
      d.url = `https://${host}`;
      d.state = 'ready';
      log(d, `Vercel deployment is live · ${d.url}`);
      return;
    }
    if (s.readyState === 'ERROR' || s.readyState === 'CANCELED') throw new Error(`Vercel reported ${s.readyState}`);
    if (cancelled.has(d.id)) throw new Error('Cancelled');
    await sleep(2000);
  }
  throw new Error('Timed out waiting for Vercel');
}

export function listDeployments(): Omit<Deployment, 'logs'>[] {
  return deployments.map(({ logs, ...rest }) => ({ ...rest, logCount: logs.length }) as Omit<Deployment, 'logs'>);
}

export function getDeployment(id: string): Deployment | undefined {
  return deployments.find((d) => d.id === id);
}

export function productionUrl(): string {
  return `http://localhost:${PROD_PORT}`;
}

export async function createDeployment(provider: Provider, target: Target): Promise<Deployment> {
  const d: Deployment = {
    id: `dpl_${randomBytes(5).toString('hex')}`,
    provider,
    target,
    state: 'queued',
    createdAt: Date.now(),
    isProduction: false,
    commit: await gitInfo(),
    logs: [],
  };
  deployments.unshift(d);
  pruneOld();
  log(d, `Deployment ${d.id} queued · ${provider} · ${target}`);
  log(d, `Source ${d.commit.sha}${d.commit.dirty ? ' + uncommitted changes' : ''} · ${d.commit.message}`);
  void (async () => {
    d.state = 'building';
    persist();
    try {
      if (provider === 'local') await runLocal(d);
      else if (provider === 'netlify') await runNetlify(d);
      else await runVercel(d);
      d.readyAt = Date.now();
      if (target === 'production') {
        if (provider === 'local') await promote(d.id);
        else markProduction(d);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      d.state = cancelled.has(d.id) ? 'cancelled' : 'error';
      d.error = msg;
      log(d, msg, 'error');
    }
    persist();
  })();
  return d;
}

function markProduction(d: Deployment): void {
  for (const x of deployments) if (x.provider === d.provider) x.isProduction = false;
  d.isProduction = true;
  persist();
}

export async function promote(id: string): Promise<Deployment> {
  const d = getDeployment(id);
  if (!d) throw new Error('Deployment not found');
  if (d.provider !== 'local') throw new Error('Promotion is available for local deployments. Redeploy to Netlify or Vercel with target production.');
  if (d.state === 'stopped') {
    log(d, 'Restarting for promotion');
    await startLocal(d);
  }
  if (d.state !== 'ready') throw new Error('Only ready deployments can be promoted');
  const previous = deployments.find((x) => x.provider === 'local' && x.isProduction);
  markProduction(d);
  ensureProxy();
  log(d, `Promoted to production · ${productionUrl()}${previous && previous !== d ? ` (replaces ${previous.id})` : ''}`);
  if (previous && previous !== d) log(previous, `Replaced in production by ${d.id}`, 'warn');
  return d;
}

export async function restart(id: string): Promise<Deployment> {
  const d = getDeployment(id);
  if (!d || d.provider !== 'local') throw new Error('Only local deployments can be restarted');
  if (procs.has(id)) throw new Error('Deployment is already running');
  d.state = 'deploying';
  try {
    await startLocal(d);
  } catch (err) {
    d.state = 'error';
    d.error = err instanceof Error ? err.message : String(err);
    log(d, d.error, 'error');
  }
  return d;
}

export function stop(id: string): Deployment {
  const d = getDeployment(id);
  if (!d) throw new Error('Deployment not found');
  if (d.isProduction && d.provider === 'local') throw new Error('Promote another deployment before stopping production');
  const p = procs.get(id);
  if (['queued', 'building', 'deploying'].includes(d.state)) {
    cancelled.add(id);
    p?.kill();
    log(d, 'Cancellation requested', 'warn');
  } else if (p) {
    p.kill();
    d.state = 'stopped';
    d.port = undefined;
    log(d, 'Stopped', 'warn');
  }
  persist();
  return d;
}

export function remove(id: string): void {
  const d = getDeployment(id);
  if (!d) throw new Error('Deployment not found');
  if (d.isProduction) throw new Error('The production deployment cannot be deleted');
  procs.get(id)?.kill();
  rmSync(deployDir(d), { recursive: true, force: true });
  deployments.splice(deployments.indexOf(d), 1);
  persist();
}

function pruneOld(): void {
  while (deployments.length > MAX_DEPLOYMENTS) {
    const victim = [...deployments].reverse().find((d) => !d.isProduction && !procs.has(d.id));
    if (!victim) break;
    rmSync(deployDir(victim), { recursive: true, force: true });
    deployments.splice(deployments.indexOf(victim), 1);
  }
}

let proxy: Server | undefined;

function prodPort(): number | undefined {
  return deployments.find((d) => d.provider === 'local' && d.isProduction && d.state === 'ready')?.port;
}

function ensureProxy(): void {
  if (proxy) return;
  proxy = createServer((req, res) => {
    const port = prodPort();
    if (!port) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('No production deployment is running. Promote a deployment from the IDE.');
      return;
    }
    const up = httpRequest({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (pr) => {
      res.writeHead(pr.statusCode ?? 502, pr.headers);
      pr.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Production deployment is not responding.');
    });
    req.pipe(up);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const port = prodPort();
    if (!port) { socket.destroy(); return; }
    const up = netConnect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  proxy.on('error', (err) => {
    console.error(`[deploy] production proxy could not listen on ${PROD_PORT}:`, err.message);
    proxy = undefined;
  });
  proxy.listen(PROD_PORT, () => console.log(`[deploy] production → ${productionUrl()}`));
}

export function initDeployments(): void {
  const prod = deployments.find((d) => d.provider === 'local' && d.isProduction);
  if (prod) {
    ensureProxy();
    if (prod.state === 'stopped') {
      prod.state = 'deploying';
      log(prod, 'Restoring production after server start');
      startLocal(prod).catch((err) => {
        prod.state = 'error';
        prod.error = err instanceof Error ? err.message : String(err);
        log(prod, prod.error, 'error');
      });
    }
  }
  const shutdown = () => {
    for (const p of procs.values()) p.kill();
    flush();
  };
  process.once('exit', shutdown);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      shutdown();
      process.exit(0);
    });
  }
}

export function providerStatus() {
  return {
    local: { ready: true, productionUrl: productionUrl() },
    netlify: { ready: Boolean(env('NETLIFY_AUTH_TOKEN')), needs: 'NETLIFY_AUTH_TOKEN', optional: 'NETLIFY_SITE_ID' },
    vercel: { ready: Boolean(env('VERCEL_TOKEN')), needs: 'VERCEL_TOKEN', optional: 'VERCEL_TEAM_ID, VERCEL_PROJECT' },
  };
}
