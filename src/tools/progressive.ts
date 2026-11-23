import { listMcpTools, callMcpTool } from '../connectors/mcp-client.js';
import type { ToolSpec } from '../llm/index.js';
import { listSkills, loadSkill, skillIndexText } from './skills.js';

// Instead of loading every MCP tool definition into the prompt, agents get four small
// meta-tools and pull in only the definitions they search for.

let cache: { at: number; tools: ToolSpec[] } | null = null;

export async function allTools(): Promise<ToolSpec[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.tools;
  const tools = (await listMcpTools()).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }));
  cache = { at: Date.now(), tools };
  return tools;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[_\-./]/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

export async function searchTools(query: string, limit = 6): Promise<ToolSpec[]> {
  const tools = await allTools();
  const q = tokenize(query);
  if (!q.length) return tools.slice(0, limit);
  const docs = tools.map((t) => ({ t, words: tokenize(`${t.name} ${t.name} ${t.description}`) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d.words)) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((s, d) => s + d.words.length, 0) / Math.max(1, docs.length);
  const scored = docs.map((d) => {
    let score = 0;
    for (const term of q) {
      const tf = d.words.filter((w) => w === term || (term.length > 3 && w.startsWith(term))).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.words.length / avg))));
    }
    return { t: d.t, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.t);
}

export const META_TOOLS: ToolSpec[] = [
  { name: 'search_tools', description: 'Search the platform tool catalog (hundreds of MCP tools) and get full definitions for the best matches. Call this before call_tool.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What you want to do, e.g. "google ads keyword ideas"' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'call_tool', description: 'Call a platform tool found with search_tools.', input_schema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  { name: 'list_skills', description: 'List installed skills (name and one-line description). Skills are written procedures; load one when it matches the task.', input_schema: { type: 'object', properties: {} } },
  { name: 'load_skill', description: 'Load the full text of a skill, or one of its extra files.', input_schema: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string' } }, required: ['name'] } },
];

export async function runMetaTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_tools': {
      const found = await searchTools(String(input.query ?? ''), Math.min(15, Number(input.limit) || 6));
      return found.length ? found : 'No matching tools. Try other words.';
    }
    case 'call_tool': {
      const toolName = String(input.name ?? '');
      if (!(await allTools()).some((t) => t.name === toolName)) throw new Error(`Unknown tool ${toolName}. Use search_tools first.`);
      return callMcpTool(toolName, (input.args as Record<string, unknown>) ?? {});
    }
    case 'list_skills':
      return skillIndexText();
    case 'load_skill':
      return loadSkill(String(input.name ?? ''), input.file ? String(input.file) : undefined);
    default:
      throw new Error(`Unknown meta tool ${name}`);
  }
}

export function isMetaTool(name: string): boolean {
  return META_TOOLS.some((t) => t.name === name);
}

const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

export async function toolAccessStats() {
  let tools: ToolSpec[] = [];
  let error: string | null = null;
  try { tools = await allTools(); } catch (err) { error = err instanceof Error ? err.message : String(err); }
  const full = tokens(tools);
  const progressive = tokens(META_TOOLS);
  return {
    mcpTools: tools.length,
    skills: listSkills().length,
    tokens: { full, progressive, code: progressive + 120 },
    savingsPct: full ? Math.round((1 - progressive / full) * 1000) / 10 : 0,
    error,
  };
}
