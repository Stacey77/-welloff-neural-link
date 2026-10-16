import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from './workspace.js';

const ENV_FILE = join(REPO_ROOT, '.env');
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function rawLines(): string[] {
  return existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
}

function parseLine(line: string): [string, string] | null {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) return null;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  } else {
    v = v.replace(/\s+#.*$/, '');
  }
  return [m[1], v];
}

export function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of rawLines()) {
    const kv = parseLine(line);
    if (kv) out[kv[0]] = kv[1];
  }
  return out;
}

function mask(value: string): string {
  if (!value) return '(empty)';
  if (value.length < 12) return '•'.repeat(Math.min(value.length, 8));
  return `••••••••${value.slice(-4)}`;
}

export function listEnv(): { key: string; preview: string; length: number }[] {
  return Object.entries(readEnvFile())
    .map(([key, value]) => ({ key, preview: mask(value), length: value.length }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function serialize(value: string): string {
  return /[\s#"'=]/.test(value) ? JSON.stringify(value) : value;
}

export function setEnv(key: string, value: string): void {
  if (!KEY_RE.test(key)) throw new Error('Names may use letters, digits and underscores, and cannot start with a digit.');
  if (/[\r\n]/.test(value)) throw new Error('Values cannot contain line breaks.');
  const lines = rawLines();
  const line = `${key}=${serialize(value)}`;
  const idx = lines.findIndex((l) => parseLine(l)?.[0] === key);
  if (idx >= 0) lines[idx] = line;
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line);
  }
  writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
}

export function deleteEnv(key: string): boolean {
  const lines = rawLines();
  const next = lines.filter((l) => parseLine(l)?.[0] !== key);
  if (next.length === lines.length) return false;
  writeFileSync(ENV_FILE, next.join('\n'), 'utf8');
  return true;
}
