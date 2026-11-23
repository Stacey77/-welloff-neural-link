import { ask } from '../llm/index.js';
import {
  ENTITY_TYPES, applyDrafts, isEntityStatus, isEntityType, normalize,
  type EntityDraft, type EntityRef, type EntityType, type FactSource,
} from './memory.js';

/* ── Dates ──
 * All dates resolve in the server's local time zone. A date without a time means the end of that day (23:59).
 * Numeric dates are US style: 3/12/2026 is March 12, 2026 (M/D/Y).
 * A weekday ("Friday", "by Friday", "next Friday") is its next occurrence strictly after today.
 */

export interface ParsedDate { at: Date; text: string; index: number; hasTime: boolean }

const DAY_MS = 86_400_000;
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 };

const monthIndex = (m: string): number => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m.slice(0, 3).toLowerCase());

function dayEnd(y: number, m: number, d: number): Date | null {
  const dt = new Date(y, m, d, 23, 59, 0, 0);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

function plusDays(now: Date, n: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 23, 59, 0, 0);
}

// A date with no year means its next occurrence (today counts).
function nextYearly(m: number, d: number, now: Date): Date | null {
  const y = now.getFullYear();
  const dt = dayEnd(y, m, d);
  if (!dt) return null;
  return dt.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() ? dayEnd(y + 1, m, d) : dt;
}

const TIME_AFTER = /^\s*,?\s*(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])|^\s*,?\s*(?:at|@)\s*(\d{1,2}):(\d{2})\b/i;

function withTime(date: Date, rest: string): { date: Date; extra: number } | null {
  const t = TIME_AFTER.exec(rest);
  if (!t) return null;
  let h = Number(t[1] ?? t[4]);
  const min = Number(t[2] ?? t[5] ?? 0);
  const ap = (t[3] ?? '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(date);
  d.setHours(h, min, 0, 0);
  return { date: d, extra: t[0].length };
}

interface Rule { re: RegExp; resolve: (m: RegExpExecArray, now: Date) => { date: Date; hasTime?: boolean } | null; timeable?: boolean }

const RULES: Rule[] = [
  {
    re: /\b(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g,
    resolve: (m) => {
      const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
      if (m[4] === undefined) { const dt = dayEnd(y, mo, d); return dt ? { date: dt } : null; }
      const pad = (v: string | number) => String(v).padStart(2, '0');
      const local = `${y}-${pad(mo + 1)}-${pad(d)}T${pad(m[4])}:${m[5]}:${m[6] ?? '00'}`;
      const dt = new Date(m[7] ? `${local}${m[7] === 'Z' ? 'Z' : m[7].replace(/(\d{2})(\d{2})$/, '$1:$2')}` : local);
      return Number.isNaN(dt.getTime()) ? null : { date: dt, hasTime: true };
    },
    timeable: true,
  },
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g,
    resolve: (m) => {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const dt = dayEnd(y, Number(m[1]) - 1, Number(m[2]));
      return dt ? { date: dt } : null;
    },
    timeable: true,
  },
  {
    re: new RegExp(`\\b(${MONTH_RE})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\d:])`, 'gi'),
    resolve: (m, now) => {
      const mo = monthIndex(m[1]); const d = Number(m[2]);
      const dt = m[3] ? dayEnd(Number(m[3]), mo, d) : nextYearly(mo, d, now);
      return dt ? { date: dt } : null;
    },
    timeable: true,
  },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi'),
    resolve: (m, now) => {
      const mo = monthIndex(m[2]); const d = Number(m[1]);
      const dt = m[3] ? dayEnd(Number(m[3]), mo, d) : nextYearly(mo, d, now);
      return dt ? { date: dt } : null;
    },
    timeable: true,
  },
  {
    re: /\b(today|tonight|tomorrow|tmrw|the day after tomorrow)\b/gi,
    resolve: (m, now) => {
      const w = m[1].toLowerCase();
      return { date: plusDays(now, w === 'today' || w === 'tonight' ? 0 : w.startsWith('the day after') ? 2 : 1) };
    },
    timeable: true,
  },
  {
    re: /\bin\s+(?:a\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few)\s+(days?|weeks?|months?)\b/gi,
    resolve: (m, now) => {
      const raw = m[1].toLowerCase().replace(/\s+of$/, '');
      const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
      if (!n || n > 3650) return null;
      const unit = m[2].toLowerCase();
      if (unit.startsWith('month')) return { date: new Date(now.getFullYear(), now.getMonth() + n, now.getDate(), 23, 59, 0, 0) };
      return { date: plusDays(now, unit.startsWith('week') ? n * 7 : n) };
    },
  },
  {
    re: /\b(?:(next|this|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    resolve: (m, now) => {
      const target = WEEKDAYS.indexOf(m[2].toLowerCase());
      return { date: plusDays(now, ((target - now.getDay() + 7) % 7) || 7) };
    },
    timeable: true,
  },
  {
    re: /\b(?:the\s+)?end\s+of\s+(?:the\s+)?(week|month)\b/gi,
    resolve: (m, now) => m[1].toLowerCase() === 'week'
      ? { date: plusDays(now, ((5 - now.getDay() + 7) % 7)) }
      : { date: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 0, 0) },
  },
];

export function findDates(text: string, now: number | Date = Date.now()): ParsedDate[] {
  const base = new Date(now);
  const found: ParsedDate[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const r = rule.resolve(m, base);
      if (!r) continue;
      let { date } = r;
      let len = m[0].length;
      let hasTime = Boolean(r.hasTime);
      if (rule.timeable && !hasTime) {
        const t = withTime(date, text.slice(m.index + len));
        if (t) { date = t.date; len += t.extra; hasTime = true; }
      }
      found.push({ at: date, text: text.slice(m.index, m.index + len).trim(), index: m.index, hasTime });
    }
  }
  found.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const out: ParsedDate[] = [];
  for (const d of found) {
    const prev = out[out.length - 1];
    if (prev && d.index < prev.index + prev.text.length) continue;
    out.push(d);
  }
  return out;
}

export function parseDate(text: string, now: number | Date = Date.now()): Date | null {
  const s = text.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return findDates(s, now)[0]?.at ?? null;
}

/* ── Heuristic entity extraction ── */

export interface Extraction {
  entities: EntityDraft[];
  deadlines: EntityDraft[];
  facts: { about: EntityRef; text: string }[];
  via: 'heuristic' | 'llm+heuristic';
  llmError?: string;
}

interface Mention { type: EntityType; name: string; index: number; aliases?: string[] }

const CAP = `[A-Z][A-Za-z'’&-]*`;
const NAME = `${CAP}(?:\\s+${CAP}){0,3}`;
const LEAD_WORDS = new Set(['the', 'a', 'an', 'my', 'our', 'with', 'for', 'from', 'and', 'at', 'to', 'by', 'of', 'is', 'client', 'customer', 'prospect', 'lead', 'project', 'also', 'and', 'then', 'but', 'so', 'when', 'yesterday', 'today', 'tomorrow', 'i', 'we']);
const NOT_NAMES = new Set([...WEEKDAYS, 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'llc', 'inc']);
const PROJECT_NOUNS = 'project|renovation|remodel|rehab|build|buildout|redesign|website|app|launch|campaign|deal|listing|flip|development|rollout|migration';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_RE = /(?<![\w/-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w/-])/g;
const DEADLINE_CUE = /\b(by|due|deadline|before|until|no later than|owe|owes|needs?|must|submit|deliver|send|finish|complete|file|pay|renew|expires?)\b/i;

function cleanName(raw: string): string {
  const words = raw.replace(/[’']s$/, '').trim().split(/\s+/);
  while (words.length > 1 && LEAD_WORDS.has(words[0].toLowerCase())) words.shift();
  return words.join(' ').replace(/[,.;:]+$/, '');
}

const isPlausible = (name: string): boolean => {
  const n = normalize(name);
  return n.length > 1 && !NOT_NAMES.has(n) && !LEAD_WORDS.has(n);
};

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/).map((s) => s.trim()).filter(Boolean);
}

function mentionsIn(s: string): Mention[] {
  const out: Mention[] = [];
  const push = (type: EntityType, raw: string, index: number, aliases?: string[]) => {
    const name = cleanName(raw);
    if (isPlausible(name)) out.push({ type, name, index, aliases });
  };

  const company = new RegExp(`((?:${CAP}\\s+){1,4})(LLC|L\\.L\\.C\\.?|Inc\\.?|Corp\\.?|Corporation|Ltd\\.?)(?![A-Za-z])`, 'g');
  for (const m of s.matchAll(company)) {
    const base = cleanName(m[1]);
    const suffix = m[2].replace(/\.$/, '').replace(/^L\.L\.C$/, 'LLC');
    const before = s.slice(Math.max(0, m.index! - 14), m.index!).toLowerCase();
    const type: EntityType = /prospect|lead/.test(before) ? 'prospect' : /client|customer/.test(before) ? 'client' : 'llc';
    push(type, `${base} ${suffix}`, m.index! + m[1].indexOf(base), [base]);
  }

  const role = new RegExp(`\\b([Cc]lients?|[Cc]ustomers?|[Pp]rospects?|[Ll]eads?|[Pp]rojects?)\\s*:?\\s+(?:named\\s+|called\\s+)?(${NAME})(?:\\s+(${PROJECT_NOUNS})\\b)?`, 'g');
  for (const m of s.matchAll(role)) {
    const kw = m[1].toLowerCase();
    const type: EntityType = kw.startsWith('client') || kw.startsWith('customer') ? 'client' : kw.startsWith('project') ? 'project' : 'prospect';
    const name = type === 'project' && m[3] && m[3] !== 'project' ? `${m[2]} ${m[3]}` : m[2];
    push(type, name, m.index! + m[0].indexOf(m[2]));
  }

  const isA = new RegExp(`(${NAME})\\s+(?:is|are)\\s+(?:a|an|my|our|the)\\s+(?:new\\s+|potential\\s+|big\\s+)?(client|customer|prospect|lead)\\b`, 'g');
  for (const m of s.matchAll(isA)) push(/client|customer/.test(m[2]) ? 'client' : 'prospect', m[1], m.index!);

  const project = new RegExp(`(${NAME})\\s+(${PROJECT_NOUNS})\\b`, 'g');
  for (const m of s.matchAll(project)) {
    const base = cleanName(m[1]);
    if (out.some((x) => x.type !== 'project' && normalize(x.name) === normalize(base))) continue;
    push('project', m[2] === 'project' ? base : `${base} ${m[2]}`, m.index! + m[1].indexOf(base));
  }

  const person = new RegExp(`\\b(?:with|met|meet|meeting|called|call|emailed|email|texted|text|ask|asked|tell|told|cc|contact|introduced|thank)\\s+(${CAP}\\s+${CAP}(?:\\s+${CAP})?)`, 'g');
  for (const m of s.matchAll(person)) push('person', m[1], m.index! + m[0].indexOf(m[1]));

  // One mention per name; a specific role beats a generic one.
  const rank: Record<EntityType, number> = { client: 5, prospect: 5, llc: 4, project: 3, person: 2, deadline: 1, booking: 1, note: 0 };
  const byName = new Map<string, Mention>();
  for (const m of out) {
    const k = normalize(m.name);
    const prev = byName.get(k);
    if (!prev || rank[m.type] > rank[prev.type]) byName.set(k, m);
  }
  return [...byName.values()].sort((a, b) => a.index - b.index);
}

function deadlineName(s: string, date: ParsedDate): string {
  const head = s.slice(0, date.index);
  const verb = /\b(?:needs?|owe|owes|deliver|send|submit|finish|complete|file|pay|renew|prepare|get|have)\s+(?:to\s+(?:\w+\s+)?)?(?:(?:him|her|them|me|us)\s+)?(.{3,90}?)\s*(?:\b(?:by|before|due|until|on|no later than))?\s*$/i.exec(head);
  const due = /([^,;]{3,90}?)\s+(?:is\s+|are\s+)?due\s*(?:on|by)?\s*$/i.exec(head);
  const raw = verb?.[1] ?? due?.[1];
  if (raw) return raw.replace(/^(?:the|a|an|my|our|his|her|their)\s+/i, '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const rest = s.replace(date.text, '').replace(/\s+/g, ' ').replace(/\b(by|due|on|before|until)\s*([.,;!]|$)/i, '$2').replace(/[.!]+$/, '').trim();
  return rest.length > 70 ? `${rest.slice(0, 67)}...` : rest;
}

export function extractHeuristic(text: string, now: number = Date.now()): Extraction {
  const drafts = new Map<string, EntityDraft>();
  const facts: { about: EntityRef; text: string }[] = [];
  const keyOf = (r: EntityRef) => `${r.type}:${normalize(r.name)}`;
  const draftFor = (m: { type: EntityType; name: string; aliases?: string[] }): EntityDraft => {
    const k = keyOf(m);
    let d = drafts.get(k);
    if (!d) { d = { type: m.type, name: m.name, aliases: [], facts: [], links: [] }; drafts.set(k, d); }
    for (const a of m.aliases ?? []) if (normalize(a) !== normalize(d.name) && !d.aliases!.includes(a)) d.aliases!.push(a);
    return d;
  };
  const addLink = (d: EntityDraft, rel: string, to: EntityRef) => {
    if (keyOf(d) === keyOf(to) || d.links!.some((l) => l.rel === rel && keyOf(l.to) === keyOf(to))) return;
    d.links!.push({ rel, to: { type: to.type, name: to.name } });
  };
  const addFact = (d: EntityDraft, f: string) => {
    if (!d.facts!.includes(f)) { d.facts!.push(f); facts.push({ about: { type: d.type, name: d.name }, text: f }); }
  };

  for (const s of sentences(text)) {
    if (/\?\s*$/.test(s)) continue;
    const fact = s.length > 300 ? `${s.slice(0, 297)}...` : s;
    const mentions = mentionsIn(s);
    const people = mentions.filter((m) => m.type === 'client' || m.type === 'prospect' || m.type === 'person');

    const contacts: { kind: 'email' | 'phone'; value: string; index: number }[] = [
      ...[...s.matchAll(EMAIL_RE)].map((m) => ({ kind: 'email' as const, value: m[0].toLowerCase(), index: m.index! })),
      ...[...s.matchAll(PHONE_RE)].map((m) => ({ kind: 'phone' as const, value: m[0].trim(), index: m.index! })),
    ];
    for (const c of contacts) {
      const owner = [...people].reverse().find((p) => p.index < c.index) ?? people.find((p) => p.index > c.index);
      const d = owner ? draftFor(owner) : draftFor({ type: 'person', name: c.value });
      if (c.kind === 'email' && !d.email) d.email = c.value;
      if (c.kind === 'phone' && !d.phone) d.phone = c.value;
    }

    for (const m of mentions) {
      const d = draftFor(m);
      addFact(d, fact);
      if (m.type === 'prospect') {
        if (/\b(signed|won|closed the deal|said yes|accepted)\b/i.test(s)) d.status = 'won';
        else if (/\b(passed|declined|said no|not interested|went with someone else)\b/i.test(s)) d.status = 'lost';
      }
    }

    const byType = (t: EntityType) => mentions.filter((m) => m.type === t);
    for (const p of byType('project')) {
      for (const c of [...byType('client'), ...byType('prospect')]) addLink(draftFor(p), 'client', c);
      for (const l of byType('llc')) addLink(draftFor(p), 'llc', l);
    }
    for (const c of [...byType('client'), ...byType('prospect')]) for (const l of byType('llc')) addLink(draftFor(c), 'llc', l);

    const dates = findDates(s, now);
    if (dates.length && DEADLINE_CUE.test(s)) {
      const date = dates.find((d) => d.at.getTime() >= now - 365 * DAY_MS) ?? dates[0];
      let name = deadlineName(s, date) || `Deadline ${date.text}`;
      const owner = [...byType('client'), ...byType('prospect')][0];
      if (owner && name.split(' ').length <= 3 && !normalize(name).includes(normalize(owner.name))) name = `${name} for ${owner.name}`;
      const d = draftFor({ type: 'deadline', name });
      d.dueAt = date.at.toISOString();
      addFact(d, fact);
      for (const p of byType('project')) addLink(d, 'project', p);
      for (const c of [...byType('client'), ...byType('prospect'), ...byType('person')]) addLink(d, 'for', c);
      for (const l of byType('llc')) addLink(d, 'llc', l);
    }
  }

  const all = [...drafts.values()];
  return { entities: all.filter((d) => d.type !== 'deadline'), deadlines: all.filter((d) => d.type === 'deadline'), facts, via: 'heuristic' };
}

/* ── LLM extraction ── */

const LLM_SYSTEM = 'You extract structured memory for a business owner\'s personal operations assistant. Reply with one JSON object and nothing else. Only include what the text states; never guess.';

function llmPrompt(text: string, now: number): string {
  const d = new Date(now);
  return [
    `Today is ${d.toDateString()} (${d.toISOString().slice(0, 10)}).`,
    `Extract entities from the text below. Types: ${ENTITY_TYPES.join(', ')} ("llc" = one of the owner's companies or any company).`,
    'Return: {"entities":[{"type":"client","name":"...","aliases":[],"email":null,"phone":null,"dueAt":null,"status":null,"facts":["short fact"],"related":[{"rel":"client","type":"client","name":"..."}]}]}',
    'Use type "deadline" for anything owed or due, with dueAt as an ISO 8601 date (resolve relative dates against today). status is one of open, done, won, lost, cancelled or null.',
    'related links point from this entity to another by type and name (project→client rel "client", project→llc rel "llc", deadline→project rel "project", deadline→client rel "for").',
    'If nothing is worth remembering, return {"entities":[]}.',
    '',
    'Text:',
    text,
  ].join('\n');
}

export function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const str = (v: unknown, max = 160): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function validateLlm(parsed: unknown, now: number): EntityDraft[] {
  const list = (parsed as { entities?: unknown })?.entities;
  if (!Array.isArray(list)) return [];
  const out: EntityDraft[] = [];
  for (const raw of list.slice(0, 40)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const name = str(r.name);
    if (!name || !isEntityType(r.type)) continue;
    const d: EntityDraft = { type: r.type, name, aliases: [], facts: [], links: [] };
    if (Array.isArray(r.aliases)) d.aliases = r.aliases.map((a) => str(a)).filter((a): a is string => Boolean(a)).slice(0, 8);
    if (Array.isArray(r.facts)) d.facts = r.facts.map((f) => str(f, 300)).filter((f): f is string => Boolean(f)).slice(0, 10);
    const email = str(r.email);
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) d.email = email.toLowerCase();
    const phone = str(r.phone, 40);
    if (phone && /\d{7,}/.test(phone.replace(/\D/g, ''))) d.phone = phone;
    const due = str(r.dueAt, 60);
    if (due) { const dt = parseDate(due, now); if (dt) d.dueAt = dt.toISOString(); }
    if (isEntityStatus(r.status)) d.status = r.status;
    if (Array.isArray(r.related)) {
      for (const l of r.related.slice(0, 10)) {
        const x = l as Record<string, unknown>;
        const tname = str(x?.name);
        if (tname && isEntityType(x.type)) d.links!.push({ rel: str(x.rel, 40) ?? 'related', to: { type: x.type, name: tname } });
      }
    }
    out.push(d);
  }
  return out;
}

function mergeKey(d: EntityDraft): string {
  const n = normalize(d.name);
  return `${d.type}:${d.type === 'llc' ? n.replace(/\s+(llc|inc|corp|corporation|ltd)$/, '') : n}`;
}

function sameDay(a?: string, b?: string): boolean {
  return Boolean(a && b) && new Date(a!).toDateString() === new Date(b!).toDateString();
}

function mergeDrafts(base: EntityDraft[], extra: EntityDraft[]): EntityDraft[] {
  const out: EntityDraft[] = base.map((d) => ({ ...d, aliases: [...(d.aliases ?? [])], facts: [...(d.facts ?? [])], links: [...(d.links ?? [])] }));
  for (const x of extra) {
    const target = out.find((d) => mergeKey(d) === mergeKey(x))
      ?? (x.type === 'deadline' ? out.find((d) => d.type === 'deadline' && sameDay(d.dueAt, x.dueAt)) : undefined);
    if (!target) { out.push(x); continue; }
    if (normalize(target.name) !== normalize(x.name) && !target.aliases!.some((a) => normalize(a) === normalize(x.name))) target.aliases!.push(x.name);
    for (const a of x.aliases ?? []) if (!target.aliases!.some((y) => normalize(y) === normalize(a))) target.aliases!.push(a);
    for (const f of x.facts ?? []) if (!target.facts!.some((y) => normalize(y) === normalize(f))) target.facts!.push(f);
    for (const l of x.links ?? []) if (!target.links!.some((y) => y.rel === l.rel && mergeKey({ type: y.to.type, name: y.to.name }) === mergeKey({ type: l.to.type, name: l.to.name }))) target.links!.push(l);
    target.email ??= x.email;
    target.phone ??= x.phone;
    target.dueAt ??= x.dueAt;
    target.status = x.status ?? target.status;
  }
  return out;
}

export async function extract(text: string, opts: { useLlm?: boolean; now?: number; model?: string } = {}): Promise<Extraction> {
  const now = opts.now ?? Date.now();
  const heuristic = extractHeuristic(text, now);
  if (opts.useLlm === false || !text.trim()) return heuristic;
  try {
    const r = await ask('EVE', llmPrompt(text.slice(0, 12_000), now), { system: LLM_SYSTEM, maxTokens: 1500, model: opts.model });
    const fromLlm = validateLlm(firstJsonObject(r.text), now);
    const merged = mergeDrafts([...heuristic.entities, ...heuristic.deadlines], fromLlm);
    const facts = merged.flatMap((d) => (d.facts ?? []).map((f) => ({ about: { type: d.type, name: d.name }, text: f })));
    return { entities: merged.filter((d) => d.type !== 'deadline'), deadlines: merged.filter((d) => d.type === 'deadline'), facts, via: 'llm+heuristic' };
  } catch (err) {
    return { ...heuristic, llmError: err instanceof Error ? err.message : String(err) };
  }
}

/** Extracts from text and writes the result to memory. */
export async function rememberText(text: string, opts: { useLlm?: boolean; now?: number; model?: string; source?: FactSource } = {}) {
  const ex = await extract(text, opts);
  const applied = applyDrafts([...ex.entities, ...ex.deadlines], opts.source ?? 'chat');
  return { extraction: ex, ...applied };
}
