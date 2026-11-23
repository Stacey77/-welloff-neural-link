import { randomUUID } from 'crypto';
import { isObject, persisted } from './store.js';

export const ENTITY_TYPES = ['llc', 'client', 'project', 'person', 'prospect', 'deadline', 'booking', 'note'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const ENTITY_STATUSES = ['open', 'done', 'won', 'lost', 'cancelled'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];
export type FactSource = 'chat' | 'event' | 'manual';

export interface Fact { text: string; source: FactSource; at: string }
export interface Relation { id: string; rel: string }

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  facts: Fact[];
  related: Relation[];
  email?: string;
  phone?: string;
  dueAt?: string;
  startAt?: string;
  endAt?: string;
  status?: EntityStatus;
  review?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EntityRef { type: EntityType; name: string }

// What extraction, events and manual input produce; links point at other entities by type+name.
export interface EntityDraft {
  type: EntityType;
  name: string;
  aliases?: string[];
  facts?: string[];
  email?: string;
  phone?: string;
  dueAt?: string;
  startAt?: string;
  endAt?: string;
  status?: EntityStatus;
  review?: boolean;
  related?: Relation[];
  links?: { rel: string; to: EntityRef }[];
}

export interface UpsertResult { entity: Entity; created: boolean; addedFacts: string[] }

interface MemoryFile { version: 1; entities: Entity[] }

const store = persisted<MemoryFile>(
  'memory.json',
  () => ({ version: 1, entities: [] }),
  (v): v is MemoryFile => isObject(v) && Array.isArray(v.entities),
);

const MAX_FACTS = 60;

export const isEntityType = (v: unknown): v is EntityType => typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);
export const isEntityStatus = (v: unknown): v is EntityStatus => typeof v === 'string' && (ENTITY_STATUSES as readonly string[]).includes(v);

export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9@.+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const COMPANY_SUFFIX = /\s+(llc|l l c|inc|corp|corporation|ltd|co|company)\.?$/;
const stripSuffix = (n: string): string => n.replace(COMPANY_SUFFIX, '').trim();

function entities(): Entity[] {
  return store.get().entities;
}

function nowIso(): string {
  return new Date().toISOString();
}

function names(e: Entity): string[] {
  return [e.name, ...e.aliases].map(normalize);
}

export function findByName(name: string, types?: EntityType[]): Entity | undefined {
  const n = normalize(name);
  if (!n) return undefined;
  const pool = types ? entities().filter((e) => types.includes(e.type)) : entities();
  const exact = pool.find((e) => names(e).includes(n));
  if (exact) return exact;
  const bare = stripSuffix(n);
  return pool.find((e) => e.type === 'llc' && names(e).some((x) => stripSuffix(x) === bare));
}

export function findByEmail(email: string, types?: EntityType[]): Entity | undefined {
  const m = email.trim().toLowerCase();
  if (!m) return undefined;
  return entities().find((e) => (!types || types.includes(e.type)) && e.email?.toLowerCase() === m);
}

export function get(id: string): Entity | undefined {
  return entities().find((e) => e.id === id);
}

function addFact(e: Entity, text: string, source: FactSource): boolean {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!t) return false;
  const n = normalize(t);
  if (e.facts.some((f) => normalize(f.text) === n)) return false;
  e.facts.push({ text: t, source, at: nowIso() });
  if (e.facts.length > MAX_FACTS) e.facts.splice(0, e.facts.length - MAX_FACTS);
  return true;
}

function addRelation(e: Entity, rel: Relation): boolean {
  if (rel.id === e.id || !get(rel.id)) return false;
  if (e.related.some((r) => r.id === rel.id && r.rel === rel.rel)) return false;
  e.related.push({ id: rel.id, rel: rel.rel });
  return true;
}

export function upsert(draft: EntityDraft, source: FactSource = 'manual'): UpsertResult {
  const name = draft.name.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!name) throw new Error('An entity needs a name.');
  if (!isEntityType(draft.type)) throw new Error(`Unknown entity type "${String(draft.type)}". Use one of: ${ENTITY_TYPES.join(', ')}.`);
  const lookups = [name, ...(draft.aliases ?? [])];
  let entity = lookups.map((n) => findByName(n, [draft.type])).find(Boolean)
    ?? (draft.email ? findByEmail(draft.email, [draft.type]) : undefined);
  const created = !entity;
  if (!entity) {
    const at = nowIso();
    entity = { id: randomUUID(), type: draft.type, name, aliases: [], facts: [], related: [], createdAt: at, updatedAt: at };
    entities().push(entity);
  }
  const e = entity;
  for (const a of draft.aliases ?? []) {
    const alias = a.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (alias && !names(e).includes(normalize(alias))) e.aliases.push(alias);
  }
  if (!created && normalize(name) !== normalize(e.name) && !names(e).includes(normalize(name))) e.aliases.push(name);
  if (draft.email) e.email = draft.email.trim().toLowerCase();
  if (draft.phone) e.phone = draft.phone.trim();
  if (draft.dueAt) e.dueAt = draft.dueAt;
  if (draft.startAt) e.startAt = draft.startAt;
  if (draft.endAt) e.endAt = draft.endAt;
  if (draft.status) e.status = draft.status;
  else if (created && (e.type === 'deadline' || e.type === 'prospect' || e.type === 'booking' || e.type === 'project')) e.status = 'open';
  if (draft.review !== undefined) e.review = draft.review;
  const addedFacts = (draft.facts ?? []).filter((f) => addFact(e, f, source));
  for (const r of draft.related ?? []) addRelation(e, r);
  e.updatedAt = nowIso();
  store.save();
  return { entity: e, created, addedFacts };
}

export function addFacts(id: string, facts: string[], source: FactSource): string[] {
  const e = get(id);
  if (!e) return [];
  const added = facts.filter((f) => addFact(e, f, source));
  if (added.length) { e.updatedAt = nowIso(); store.save(); }
  return added;
}

export function update(id: string, patch: Partial<Pick<Entity, 'status' | 'dueAt' | 'email' | 'phone' | 'review' | 'name' | 'startAt' | 'endAt'>>): Entity | undefined {
  const e = get(id);
  if (!e) return undefined;
  Object.assign(e, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  e.updatedAt = nowIso();
  store.save();
  return e;
}

export function setStatus(id: string, status: EntityStatus): Entity | undefined {
  return update(id, { status });
}

export function link(fromId: string, toId: string, rel: string): boolean {
  const e = get(fromId);
  if (!e || !get(toId)) return false;
  const added = addRelation(e, { id: toId, rel: rel.trim() || 'related' });
  if (added) { e.updatedAt = nowIso(); store.save(); }
  return added;
}

export function remove(id: string): boolean {
  const list = entities();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  for (const e of list) e.related = e.related.filter((r) => r.id !== id);
  store.save();
  return true;
}

export function list(filter: { type?: EntityType; query?: string; limit?: number } = {}): Entity[] {
  if (filter.query?.trim()) return search(filter.query, { type: filter.type, limit: filter.limit }).map((h) => h.entity);
  const out = entities().filter((e) => !filter.type || e.type === filter.type);
  return [...out].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, filter.limit ?? 500);
}

/** Both directions: entities this one points at, and entities pointing at it. */
export function relatedOf(id: string): { entity: Entity; rel: string; direction: 'out' | 'in' }[] {
  const e = get(id);
  if (!e) return [];
  const out = e.related.map((r) => ({ entity: get(r.id), rel: r.rel, direction: 'out' as const }));
  const inbound = entities().filter((x) => x.related.some((r) => r.id === id)).map((x) => ({ entity: x, rel: x.related.find((r) => r.id === id)!.rel, direction: 'in' as const }));
  return [...out, ...inbound].filter((x): x is { entity: Entity; rel: string; direction: 'out' | 'in' } => Boolean(x.entity));
}

const STOPWORDS = new Set('the a an and or of to for in on at by is are was were be been my our your me i we you he she it they them his her their what when where who how why do does did have has had owe with from about this that these those any some can could should would will just please tell know need needs there here up out than then also not no yes'.split(' '));

export function tokens(text: string): string[] {
  return [...new Set(normalize(text).split(' ').filter((t) => t.length > 2 && !STOPWORDS.has(t)))];
}

export interface SearchHit { entity: Entity; score: number }

export function search(query: string, opts: { type?: EntityType; limit?: number; now?: number } = {}): SearchHit[] {
  const q = normalize(query);
  const qt = tokens(query);
  if (!q) return [];
  const now = opts.now ?? Date.now();
  const hits: SearchHit[] = [];
  for (const e of entities()) {
    if (opts.type && e.type !== opts.type) continue;
    let score = 0;
    const ns = names(e);
    if (ns.includes(q)) score += 100;
    else if (ns.some((n) => n.includes(q) || (n.length > 2 && q.includes(n)))) score += 60;
    if (e.email && (q.includes(e.email) || e.email.startsWith(q))) score += 80;
    const nameTokens = new Set(ns.flatMap((n) => n.split(' ')));
    for (const t of qt) if (nameTokens.has(t)) score += 20;
    let factScore = 0;
    for (const f of e.facts) {
      const ft = normalize(f.text);
      for (const t of qt) if (ft.includes(t)) factScore += 3;
    }
    score += Math.min(factScore, 18);
    if (score <= 0) continue;
    const ageDays = (now - Date.parse(e.updatedAt)) / 86_400_000;
    score += 10 * Math.exp(-Math.max(0, ageDays) / 30);
    hits.push({ entity: e, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20);
}

export const isOpen = (e: Entity): boolean => !e.status || e.status === 'open';

export function upcomingDeadlines(withinDays = 14, now = Date.now()): Entity[] {
  return entities()
    .filter((e) => e.dueAt && e.type !== 'booking' && isOpen(e) && Date.parse(e.dueAt) - now <= withinDays * 86_400_000)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
}

/** Search hits plus their direct relations. */
export function relevantEntities(text: string, limit = 12, now = Date.now()): Entity[] {
  const picked = new Map<string, Entity>();
  const add = (e: Entity) => { if (!picked.has(e.id)) picked.set(e.id, e); };
  const hits = search(text, { limit, now });
  for (const h of hits) add(h.entity);
  for (const h of hits.slice(0, 5)) for (const r of relatedOf(h.entity.id)) add(r.entity);
  return [...picked.values()].slice(0, limit);
}

/** Relevant entities, plus deadlines due within 14 days and open prospects. */
export function contextEntities(text: string, limit = 12, now = Date.now()): Entity[] {
  const direct = relevantEntities(text, limit, now);
  const always = [
    ...upcomingDeadlines(14, now),
    ...entities().filter((e) => e.type === 'prospect' && isOpen(e)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8),
  ];
  const out = new Map(direct.map((e) => [e.id, e]));
  for (const e of always) if (!out.has(e.id)) out.set(e.id, e);
  return [...out.values()];
}

export function formatDue(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const days = calendarDaysBetween(now, d.getTime());
  const when = days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} (${when})`;
}

export function calendarDaysBetween(from: number, to: number): number {
  const a = new Date(from); const b = new Date(to);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86_400_000);
}

export function describe(e: Entity, now = Date.now(), maxFacts = 3): string {
  const bits = [`[${e.type}] ${e.name}`];
  if (e.aliases.length) bits.push(`aka ${e.aliases.slice(0, 3).join(', ')}`);
  if (e.email) bits.push(e.email);
  if (e.phone) bits.push(e.phone);
  if (e.status) bits.push(`status ${e.status}`);
  if (e.review) bits.push('needs review');
  if (e.dueAt) bits.push(`due ${formatDue(e.dueAt, now)}`);
  if (e.startAt) bits.push(`starts ${new Date(e.startAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`);
  const rels = relatedOf(e.id).slice(0, 4).map((r) => r.direction === 'out' ? `${r.rel}: ${r.entity.name}` : `${r.entity.type} ${r.entity.name}`);
  if (rels.length) bits.push(`related ${rels.join('; ')}`);
  const facts = e.facts.slice(-maxFacts).map((f) => f.text);
  return `- ${bits.join(' | ')}${facts.length ? `\n  facts: ${facts.join(' / ')}` : ''}`;
}

export function contextFor(text: string, limit = 12, now = Date.now()): string {
  const list = contextEntities(text, limit, now);
  if (!list.length) return 'Memory is empty: nothing is known yet.';
  return list.map((e) => describe(e, now)).join('\n');
}

export function summary(now = Date.now()) {
  const counts = Object.fromEntries(ENTITY_TYPES.map((t) => [t, 0])) as Record<EntityType, number>;
  for (const e of entities()) counts[e.type]++;
  return {
    total: entities().length,
    counts,
    openDeadlines: entities().filter((e) => e.type === 'deadline' && isOpen(e)).length,
    dueWithin14Days: upcomingDeadlines(14, now).length,
    openProspects: entities().filter((e) => e.type === 'prospect' && isOpen(e)).length,
    needsReview: entities().filter((e) => e.review).length,
  };
}

const refKey = (r: EntityRef): string => `${r.type}:${normalize(r.name)}`;

/** Upserts drafts, then resolves their by-name links to ids (creating missing targets). */
export function applyDrafts(drafts: EntityDraft[], source: FactSource): { entities: Entity[]; created: Entity[]; remembered: { type: EntityType; name: string; fact: string }[] } {
  const byRef = new Map<string, Entity>();
  const created: Entity[] = [];
  const remembered: { type: EntityType; name: string; fact: string }[] = [];
  const touched = new Map<string, Entity>();
  for (const d of drafts) {
    const r = upsert({ ...d, links: undefined }, source);
    byRef.set(refKey(d), r.entity);
    touched.set(r.entity.id, r.entity);
    if (r.created) created.push(r.entity);
    for (const f of r.addedFacts) remembered.push({ type: r.entity.type, name: r.entity.name, fact: f });
    if (r.created && !r.addedFacts.length) remembered.push({ type: r.entity.type, name: r.entity.name, fact: 'new entry' });
  }
  for (const d of drafts) {
    const from = byRef.get(refKey(d));
    if (!from) continue;
    for (const l of d.links ?? []) {
      let to = byRef.get(refKey(l.to)) ?? findByName(l.to.name, [l.to.type]) ?? findByName(l.to.name);
      if (!to) {
        to = upsert({ type: l.to.type, name: l.to.name }, source).entity;
        byRef.set(refKey(l.to), to);
        touched.set(to.id, to);
        created.push(to);
        remembered.push({ type: to.type, name: to.name, fact: 'new entry' });
      }
      if (link(from.id, to.id, l.rel)) remembered.push({ type: from.type, name: from.name, fact: `${l.rel} → ${to.name}` });
    }
  }
  return { entities: [...touched.values()], created, remembered };
}

export function flushMemory(): void {
  store.flush();
}
