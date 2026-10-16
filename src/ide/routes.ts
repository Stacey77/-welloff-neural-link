import { Router } from 'express';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, resolve, relative, sep, extname } from 'path';
import { execFile } from 'child_process';
import { apiKeyAuth } from '../middleware/auth.js';

const REPO_ROOT = resolve(__dirname, '../..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const READABLE = new Set(['.ts', '.json', '.md']);
const WRITABLE = new Set(['.ts']);
const MAX_FILE_BYTES = 512 * 1024;

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

function safePath(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = resolve(SRC_ROOT, rel.replace(/^src[\\/]/, ''));
  if (abs !== SRC_ROOT && !abs.startsWith(SRC_ROOT + sep)) return null;
  return abs;
}

function walk(dir: string): TreeNode[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .map((d): TreeNode | null => {
      const abs = join(dir, d.name);
      const path = relative(SRC_ROOT, abs).split(sep).join('/');
      if (d.isDirectory()) return { name: d.name, path, type: 'dir', children: walk(abs) };
      if (!READABLE.has(extname(d.name))) return null;
      return { name: d.name, path, type: 'file' };
    })
    .filter((n): n is TreeNode => n !== null)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

interface Problem {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

function parseTscOutput(out: string): Problem[] {
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
  const problems: Problem[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    problems.push({
      file: m[1].replace(/^src\//, ''),
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5],
    });
  }
  return problems;
}

export const ideRouter = Router();

ideRouter.use(apiKeyAuth);

ideRouter.get('/fs/tree', (_req, res) => {
  res.json({ root: 'src', tree: walk(SRC_ROOT) });
});

ideRouter.get('/fs/file', (req, res) => {
  const abs = safePath(req.query.path);
  if (!abs || !READABLE.has(extname(abs)) || !existsSync(abs)) {
    res.status(404).json({ error: 'file not found or not readable' });
    return;
  }
  if (statSync(abs).size > MAX_FILE_BYTES) {
    res.status(413).json({ error: 'file too large' });
    return;
  }
  res.json({ path: req.query.path, content: readFileSync(abs, 'utf8') });
});

ideRouter.put('/fs/file', (req, res) => {
  const { path, content } = (req.body ?? {}) as { path?: unknown; content?: unknown };
  const abs = safePath(path);
  if (!abs || !WRITABLE.has(extname(abs))) {
    res.status(400).json({ error: 'only .ts files inside src/ can be saved' });
    return;
  }
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) {
    res.status(400).json({ error: 'content must be a string under 512KB' });
    return;
  }
  writeFileSync(abs, content, 'utf8');
  res.json({ saved: true, path, bytes: Buffer.byteLength(content) });
});

ideRouter.post('/build', (_req, res) => {
  const started = Date.now();
  execFile(
    process.execPath,
    [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false'],
    { cwd: REPO_ROOT, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      const problems = parseTscOutput(output);
      res.json({
        ok: !err && problems.length === 0,
        problems,
        output,
        durationMs: Date.now() - started,
      });
    },
  );
});
