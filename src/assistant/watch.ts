import { createHash } from 'crypto';
import {
  addFacts, calendarDaysBetween, findByEmail, findByName, formatDue, get, isOpen, link, list, relatedOf, setStatus, update, upsert,
  type Entity, type EntityType,
} from './memory.js';
import { notify, type Notification } from './notify.js';
import { parseDate, rememberText } from './extract.js';

/* ── Deadline watch ── */

type Stage = '7d' | '1d' | 'today' | 'overdue';

function stageOf(due: number, now: number): Stage | null {
  if (now > due) return 'overdue';
  const days = calendarDaysBetween(now, due);
  if (days <= 0) return 'today';
  if (days === 1) return '1d';
  if (days <= 7) return '7d';
  return null;
}

function deadlineBody(e: Entity, now: number): string {
  const rel = relatedOf(e.id).slice(0, 4).map((r) => `${r.entity.type} ${r.entity.name}`);
  const last = e.facts[e.facts.length - 1]?.text;
  return [`Due ${formatDue(e.dueAt!, now)}.`, rel.length ? `Related: ${rel.join(', ')}.` : '', last ? `Note: ${last}` : ''].filter(Boolean).join(' ');
}

/** Fires the current threshold for one entity (each threshold once per due date). */
export function checkDeadline(e: Entity, now = Date.now()): Notification | null {
  if (!e.dueAt || e.type === 'booking' || !isOpen(e)) return null;
  const due = Date.parse(e.dueAt);
  if (Number.isNaN(due)) return null;
  const stage = stageOf(due, now);
  if (!stage) return null;
  const days = calendarDaysBetween(now, due);
  const title = stage === 'overdue' ? `Overdue: ${e.name}`
    : stage === 'today' ? `Due today: ${e.name}`
      : stage === '1d' ? `Due tomorrow: ${e.name}`
        : `Due in ${days} days: ${e.name}`;
  return notify({
    kind: stage === 'overdue' ? 'overdue' : stage === 'today' ? 'deadline_due' : 'deadline_soon',
    title,
    body: deadlineBody(e, now),
    entityIds: [e.id, ...relatedOf(e.id).map((r) => r.entity.id)].slice(0, 6),
    key: `deadline:${e.id}:${e.dueAt}:${stage}`,
    at: now,
  });
}

export function runWatchOnce(now = Date.now()): Notification[] {
  const fired: Notification[] = [];
  for (const e of list({ limit: 100_000 })) {
    const n = checkDeadline(e, now);
    if (n) fired.push(n);
  }
  return fired;
}

let timer: NodeJS.Timeout | null = null;
let lastRun: { at: string; fired: number; error?: string } | null = null;

function tick(): void {
  try {
    lastRun = { at: new Date().toISOString(), fired: runWatchOnce().length };
  } catch (err) {
    lastRun = { at: new Date().toISOString(), fired: 0, error: err instanceof Error ? err.message : String(err) };
    console.error('[assistant] watch failed:', lastRun.error);
  }
}

export function startWatch(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  timer.unref();
  setImmediate(tick);
}

export function stopWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function watchStatus() {
  return { running: Boolean(timer), lastRun };
}

/* ── Inbound events ── */

export const EVENT_TYPES = ['booking.created', 'booking.cancelled', 'email.received', 'email.reply', 'prospect.reply', 'deadline.set', 'note'] as const;
export type AssistantEventType = (typeof EVENT_TYPES)[number];

export interface AssistantEvent {
  type: AssistantEventType;
  id?: string;
  from?: string;
  name?: string;
  email?: string;
  subject?: string;
  text?: string;
  start?: string;
  end?: string;
  dueAt?: string;
  source?: string;
  at?: string;
}

const FIELD_LIMITS: Record<Exclude<keyof AssistantEvent, 'type'>, number> = {
  id: 200, from: 300, name: 200, email: 254, subject: 300, text: 20_000, start: 100, end: 100, dueAt: 100, source: 60, at: 100,
};

export function parseEvent(raw: unknown): { event: AssistantEvent } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'An event must be a JSON object.' };
  const r = raw as Record<string, unknown>;
  const type = r.type ?? r.event;
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    return { error: `"type" must be one of: ${EVENT_TYPES.join(', ')}.` };
  }
  const event: AssistantEvent = { type: type as AssistantEventType };
  for (const [field, max] of Object.entries(FIELD_LIMITS) as [Exclude<keyof AssistantEvent, 'type'>, number][]) {
    const v = r[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number') return { error: `"${field}" must be a string.` };
    event[field] = String(v).trim().slice(0, max);
  }
  if (event.from && (!event.email || !event.name)) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(event.from);
    if (m) { event.name ??= m[1].trim() || undefined; event.email ??= m[2].trim(); }
    else if (event.from.includes('@')) event.email ??= event.from;
    else event.name ??= event.from;
  }
  if (event.email) {
    event.email = event.email.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(event.email)) return { error: `"email" is not a valid address: ${event.email}` };
  }
  for (const f of ['start', 'end', 'dueAt'] as const) {
    if (event[f] && !parseDate(event[f]!)) return { error: `"${f}" is not a date I can read: ${event[f]}` };
  }
  if (event.type === 'deadline.set' && !(event.dueAt && (event.name || event.subject))) return { error: 'deadline.set needs "dueAt" and a "name" (or "subject").' };
  if (event.type === 'note' && !event.text) return { error: 'A note event needs "text".' };
  if (['booking.created', 'booking.cancelled', 'email.received', 'email.reply', 'prospect.reply'].includes(event.type) && !event.email && !event.name) {
    return { error: `${event.type} needs the sender: "email", "name" or "from".` };
  }
  return { event };
}

const CONTACT_TYPES: EntityType[] = ['prospect', 'client', 'person', 'llc'];

export function matchContact(ev: { email?: string; name?: string }): Entity | undefined {
  if (ev.email) {
    const byEmail = findByEmail(ev.email, CONTACT_TYPES);
    if (byEmail) return byEmail;
  }
  if (ev.name) return findByName(ev.name, ['prospect', 'client', 'person']) ?? findByName(ev.name, ['llc']);
  return undefined;
}

export interface EventOutcome {
  type: AssistantEventType;
  matched: Brief | null;
  created: Brief[];
  notification: Notification | null;
  remembered?: { type: EntityType; name: string; fact: string }[];
}
interface Brief { id: string; type: EntityType; name: string; review?: boolean }

const brief = (e: Entity): Brief => ({ id: e.id, type: e.type, name: e.name, ...(e.review ? { review: true } : {}) });
const hash = (...parts: (string | undefined)[]): string => createHash('sha1').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
const snippet = (t?: string, n = 240): string => (t ? (t.replace(/\s+/g, ' ').trim().length > n ? `${t.replace(/\s+/g, ' ').trim().slice(0, n - 3)}...` : t.replace(/\s+/g, ' ').trim()) : '');
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const via = (ev: AssistantEvent): string => (ev.source ? ` (via ${ev.source})` : '');

function newContact(ev: AssistantEvent, created: Entity[]): Entity {
  const name = ev.name || ev.email!.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const e = upsert({ type: 'prospect', name, email: ev.email, review: true, facts: [`First seen in a ${ev.type} event${via(ev)}; flagged for review.`] }, 'event').entity;
  created.push(e);
  return e;
}

function adoptEmail(contact: Entity, ev: AssistantEvent): void {
  if (ev.email && !contact.email) update(contact.id, { email: ev.email });
}

export async function handleEvent(ev: AssistantEvent, now = Date.now()): Promise<EventOutcome> {
  const created: Entity[] = [];
  const out = (matched: Entity | undefined, notification: Notification | null, extra: Partial<EventOutcome> = {}): EventOutcome => ({
    type: ev.type, matched: matched ? brief(matched) : null, created: created.map(brief), notification, ...extra,
  });

  switch (ev.type) {
    case 'booking.created': {
      const known = matchContact(ev);
      const contact = known ?? newContact(ev, created);
      adoptEmail(contact, ev);
      const start = ev.start ? parseDate(ev.start, now)?.toISOString() : undefined;
      const end = ev.end ? parseDate(ev.end, now)?.toISOString() : undefined;
      const title = ev.subject || 'Meeting';
      const booking = upsert({
        type: 'booking',
        name: `${title} with ${contact.name}${start ? ` on ${when(start)}` : ''}`,
        startAt: start, endAt: end, status: 'open',
        related: [{ id: contact.id, rel: 'with' }],
        facts: [`Booked${via(ev)}${ev.text ? `: ${snippet(ev.text)}` : ''}`],
      }, 'event');
      if (booking.created) created.push(booking.entity);
      addFacts(contact.id, [`Booking: ${title}${start ? ` on ${when(start)}` : ''}${via(ev)}`], 'event');
      const n = notify({
        kind: 'booking',
        title: `New booking: ${contact.name}${start ? `, ${when(start)}` : ''}`,
        body: [`${title}${start ? ` on ${when(start)}` : ''}.`, known ? `${contact.name} is a known ${contact.type}.` : `${contact.name} is new to me and is flagged for review.`, snippet(ev.text)].filter(Boolean).join(' '),
        entityIds: [booking.entity.id, contact.id],
        key: ev.id ? `event:${ev.id}` : `booking:${contact.id}:${start ?? hash(title, ev.text)}`,
        at: now,
      });
      return out(known, n);
    }

    case 'booking.cancelled': {
      const contact = matchContact(ev);
      const start = ev.start ? parseDate(ev.start, now)?.toISOString() : undefined;
      const bookings = contact ? relatedOf(contact.id).map((r) => r.entity).filter((e) => e.type === 'booking' && isOpen(e)) : [];
      const booking = bookings.find((b) => start && b.startAt === start) ?? bookings.sort((a, b) => (b.startAt ?? '').localeCompare(a.startAt ?? ''))[0];
      if (booking) { setStatus(booking.id, 'cancelled'); addFacts(booking.id, [`Cancelled${via(ev)}${ev.text ? `: ${snippet(ev.text)}` : ''}`], 'event'); }
      if (contact) addFacts(contact.id, [`Cancelled booking${booking?.startAt ? ` for ${when(booking.startAt)}` : ''}${via(ev)}`], 'event');
      const who = contact?.name ?? ev.name ?? ev.email!;
      const n = notify({
        kind: 'booking',
        title: `Booking cancelled: ${who}`,
        body: booking ? `${booking.name} was cancelled.` : `A booking${start ? ` for ${when(start)}` : ''} was cancelled; I had no matching booking on file.`,
        entityIds: [booking?.id, contact?.id].filter((x): x is string => Boolean(x)),
        key: ev.id ? `event:${ev.id}` : `booking-cancel:${contact?.id ?? who}:${start ?? booking?.id ?? hash(ev.subject)}`,
        at: now,
      });
      return out(contact, n);
    }

    case 'email.received':
    case 'email.reply':
    case 'prospect.reply': {
      const known = matchContact(ev);
      const isProspectReply = ev.type === 'prospect.reply' || known?.type === 'prospect' || (!known && ev.type === 'email.reply');
      if (!known && !isProspectReply) {
        const n = notify({
          kind: 'info',
          title: `Email from ${ev.name ?? ev.email}`,
          body: [ev.subject ? `Subject: ${ev.subject}.` : '', snippet(ev.text), 'Sender is not in memory.'].filter(Boolean).join(' '),
          key: ev.id ? `event:${ev.id}` : `email:${hash(ev.email, ev.name, ev.subject, ev.text, ev.at)}`,
          at: now,
        });
        return out(undefined, n);
      }
      const contact = known ?? newContact(ev, created);
      adoptEmail(contact, ev);
      if (contact.type === 'prospect' && known) update(contact.id, { status: 'open' });
      const verb = ev.type === 'email.received' ? 'Emailed' : 'Replied';
      addFacts(contact.id, [`${verb}${ev.subject ? ` "${ev.subject}"` : ''}${via(ev)} on ${new Date(now).toISOString().slice(0, 10)}${ev.text ? `: ${snippet(ev.text, 200)}` : ''}`], 'event');
      const n = notify({
        kind: isProspectReply ? 'prospect_reply' : 'info',
        title: isProspectReply ? `${contact.name} replied${known ? '' : ' (new contact)'}` : `Email from ${contact.type} ${contact.name}`,
        body: [ev.subject ? `Subject: ${ev.subject}.` : '', snippet(ev.text), known ? '' : 'Added as a prospect and flagged for review.'].filter(Boolean).join(' '),
        entityIds: [contact.id],
        key: ev.id ? `event:${ev.id}` : `reply:${contact.id}:${hash(ev.subject, ev.text, ev.at)}`,
        at: now,
      });
      return out(known, n);
    }

    case 'deadline.set': {
      const dueAt = parseDate(ev.dueAt!, now)!.toISOString();
      const contact = ev.email ? findByEmail(ev.email) : undefined;
      const r = upsert({ type: 'deadline', name: (ev.name ?? ev.subject)!, dueAt, status: 'open', facts: [`Set${via(ev)}${ev.text ? `: ${snippet(ev.text)}` : ''}`] }, 'event');
      if (r.created) created.push(r.entity);
      if (contact) link(r.entity.id, contact.id, 'for');
      const n = notify({
        kind: 'info',
        title: `Deadline ${r.created ? 'added' : 'updated'}: ${r.entity.name}`,
        body: `Due ${formatDue(dueAt, now)}.`,
        entityIds: [r.entity.id],
        key: ev.id ? `event:${ev.id}` : `deadline-set:${r.entity.id}:${dueAt}`,
        at: now,
      });
      checkDeadline(get(r.entity.id)!, now);
      return out(contact, n);
    }

    case 'note': {
      const r = await rememberText(ev.text!, { source: 'event', now });
      created.push(...r.created);
      return out(undefined, null, { remembered: r.remembered });
    }
  }
}
