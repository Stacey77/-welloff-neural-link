import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, resolve, relative, sep, extname, dirname } from 'path';
import { execFile } from 'child_process';

export const REPO_ROOT = resolve(__dirname, '../..');
export const SRC_ROOT = join(REPO_ROOT, 'src');
export const DATA_DIR = join(REPO_ROOT, 'data');
export const READABLE = new Set(['.ts', '.json', '.md']);
export const WRITABLE = new Set(['.ts']);
export const MAX_FILE_BYTES = 512 * 1024;

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

export interface Problem {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export function safePath(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = resolve(SRC_ROOT, rel.replace(/^src[\\/]/, ''));
  if (abs !== SRC_ROOT && !abs.startsWith(SRC_ROOT + sep)) return null;
  return abs;
}

export function toRel(abs: string): string {
  return relative(SRC_ROOT, abs).split(sep).join('/');
}

export function listTree(dir = SRC_ROOT): TreeNode[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .map((d): TreeNode | null => {
      const abs = join(dir, d.name);
      if (d.isDirectory()) return { name: d.name, path: toRel(abs), type: 'dir', children: listTree(abs) };
      if (!READABLE.has(extname(d.name))) return null;
      return { name: d.name, path: toRel(abs), type: 'file' };
    })
    .filter((n): n is TreeNode => n !== null)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export function listFiles(nodes = listTree(), out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'dir') listFiles(n.children ?? [], out);
    else out.push(n.path);
  }
  return out;
}

export function readSrc(rel: string): string {
  const abs = safePath(rel);
  if (!abs || !READABLE.has(extname(abs)) || !existsSync(abs)) throw new Error(`file not found: ${rel}`);
  if (statSync(abs).size > MAX_FILE_BYTES) throw new Error(`file too large: ${rel}`);
  return readFileSync(abs, 'utf8');
}

export function readSrcOrEmpty(rel: string): string {
  const abs = safePath(rel);
  return abs && existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

export function writeSrc(rel: string, content: string): void {
  const abs = safePath(rel);
  if (!abs || !WRITABLE.has(extname(abs))) throw new Error('only .ts files inside src/ can be written');
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('content must be under 512KB');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

export function parseTscOutput(out: string): Problem[] {
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
  const problems: Problem[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    problems.push({ file: m[1].replace(/^src\//, ''), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
  }
  return problems;
}

export const TSC_BIN = join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

export function runTypecheck(cwd = REPO_ROOT): Promise<{ ok: boolean; problems: Problem[]; output: string; durationMs: number }> {
  const started = Date.now();
  return new Promise((done) => {
    execFile(
      process.execPath,
      [TSC_BIN, '--noEmit', '--pretty', 'false'],
      { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        const problems = parseTscOutput(output);
        done({ ok: !err && problems.length === 0, problems, output, durationMs: Date.now() - started });
      },
    );
  });
}

export function gitInfo(): Promise<{ sha: string; message: string; dirty: boolean }> {
  const run = (args: string[]) =>
    new Promise<string>((ok) => execFile('git', args, { cwd: REPO_ROOT }, (e, out) => ok(e ? '' : out.trim())));
  return Promise.all([
    run(['rev-parse', '--short', 'HEAD']),
    run(['log', '-1', '--pretty=%s']),
    run(['status', '--porcelain', '--', 'src', 'ide.html', 'index.html', 'package.json']),
  ]).then(([sha, message, status]) => ({ sha: sha || 'unknown', message: message || 'workspace', dirty: status.length > 0 }));
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch (err) {
    console.error('[ide] could not write', file, err instanceof Error ? err.message : err);
  }
}
