import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, listTree, listFiles, readSrc } from './workspace.js';

export function wrapPage(body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    `</head><body>${body}</body></html>`
  );
}

export function ideWithSnapshot(): string {
  const tree = listTree();
  const files: Record<string, string> = {};
  for (const p of listFiles(tree)) {
    if (p.endsWith('.ts')) files[p] = readSrc(p);
  }
  const ordered: Record<string, string> = files['agents/TON.ts'] ? { 'agents/TON.ts': files['agents/TON.ts'], ...files } : files;
  const json = JSON.stringify({ tree, files: ordered }).replace(/<\//g, '<\\/');
  return readFileSync(join(REPO_ROOT, 'ide.html'), 'utf8').replace(
    '<script id="demo-snapshot" type="application/json">{}</script>',
    () => `<script id="demo-snapshot" type="application/json">${json}</script>`,
  );
}

export function buildStaticSite(): Record<string, string> {
  const site: Record<string, string> = { 'index.html': wrapPage(ideWithSnapshot()) };
  const dash = join(REPO_ROOT, 'index.html');
  if (existsSync(dash)) site['dashboard/index.html'] = wrapPage(readFileSync(dash, 'utf8'));
  return site;
}
