import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../ide/workspace.js';

// Skills are folders under skills/ with a SKILL.md whose frontmatter has a name and a one-line
// description. Agents see only those lines until they load a skill (progressive disclosure).

const DIR = join(REPO_ROOT, 'skills');

export interface SkillMeta { name: string; description: string; bytes: number; files: string[] }

function parse(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta = Object.fromEntries(m[1].split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((x) => [x![1], x![2].trim()]));
  return { meta, body: m[2] };
}

export function listSkills(): SkillMeta[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((d) => existsSync(join(DIR, d, 'SKILL.md'))).map((d) => {
    const md = readFileSync(join(DIR, d, 'SKILL.md'), 'utf8');
    const { meta } = parse(md);
    return {
      name: meta.name ?? d,
      description: meta.description ?? '',
      bytes: statSync(join(DIR, d, 'SKILL.md')).size,
      files: readdirSync(join(DIR, d)).filter((f) => f !== 'SKILL.md'),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(name: string, file?: string): string {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) throw new Error(`No skill named "${name}". Call list_skills to see what exists.`);
  const folder = readdirSync(DIR).find((d) => existsSync(join(DIR, d, 'SKILL.md')) && (parse(readFileSync(join(DIR, d, 'SKILL.md'), 'utf8')).meta.name ?? d) === name)!;
  if (file) {
    if (!skill.files.includes(file)) throw new Error(`Skill ${name} has no file ${file}. Files: ${skill.files.join(', ') || 'none'}`);
    return readFileSync(join(DIR, folder, file), 'utf8');
  }
  const body = parse(readFileSync(join(DIR, folder, 'SKILL.md'), 'utf8')).body.trim();
  return skill.files.length ? `${body}\n\n(Additional files: ${skill.files.join(', ')}. Load one with load_skill and a file name.)` : body;
}

export function skillIndexText(): string {
  const s = listSkills();
  return s.length ? s.map((x) => `- ${x.name}: ${x.description}`).join('\n') : '(no skills installed)';
}
