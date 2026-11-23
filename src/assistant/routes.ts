import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { envValue } from '../llm/catalog.js';
import { lindyStatus } from '../integrations/lindy.js';
import {
  ENTITY_STATUSES, ENTITY_TYPES, get, isEntityStatus, isEntityType, list, relatedOf, remove, setStatus, summary, upsert, link,
  type EntityDraft, type EntityType,
} from './memory.js';
import { list as listNotifications, markRead, subscribe, unreadCount } from './notify.js';
import { handleEvent, parseEvent, watchStatus, type EventOutcome } from './watch.js';
import { chat, getHistory } from './eve.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MAX_EVENTS = 50;

function bad(res: Response, error: string): void {
  res.status(400).json({ error });
}

const strList = (v: unknown): string[] | null => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.map((x) => x.trim()).filter(Boolean) : null);

export const assistantRouter = Router();

assistantRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    memory: summary(),
    unread: unreadCount(),
    watch: watchStatus(),
    lindy: { outbound: lindyStatus().outbound },
    webhook: { path: '/assistant/events', secretConfigured: Boolean(envValue('ASSISTANT_WEBHOOK_SECRET')) },
  });
});

/* ── Memory ── */

assistantRouter.get('/memory', (req: Request, res: Response) => {
  const rawType = req.query.type ? String(req.query.type) : undefined;
  if (rawType && !isEntityType(rawType)) return bad(res, `type must be one of: ${ENTITY_TYPES.join(', ')}.`);
  const type = rawType as EntityType | undefined;
  const q = req.query.q ? String(req.query.q).slice(0, 500) : undefined;
  res.json({ entities: list({ type, query: q }), summary: summary() });
});

assistantRouter.get('/memory/:id', (req: Request, res: Response) => {
  const e = get(req.params.id);
  if (!e) return void res.status(404).json({ error: 'No entity with that id.' });
  res.json({ entity: e, related: relatedOf(e.id).map((r) => ({ id: r.entity.id, type: r.entity.type, name: r.entity.name, rel: r.rel, direction: r.direction })) });
});

assistantRouter.post('/memory', (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!isEntityType(b.type)) return bad(res, `"type" must be one of: ${ENTITY_TYPES.join(', ')}.`);
  if (typeof b.name !== 'string' || !b.name.trim()) return bad(res, '"name" is required.');
  const aliases = strList(b.aliases);
  if (!aliases) return bad(res, '"aliases" must be an array of strings.');
  const facts = typeof b.fact === 'string' ? [b.fact] : strList(b.facts);
  if (!facts) return bad(res, '"facts" must be an array of strings.');
  if (b.status !== undefined && !isEntityStatus(b.status)) return bad(res, `"status" must be one of: ${ENTITY_STATUSES.join(', ')}.`);
  if (b.email !== undefined && (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))) return bad(res, '"email" is not a valid address.');
  if (b.phone !== undefined && typeof b.phone !== 'string') return bad(res, '"phone" must be a string.');
  let dueAt: string | undefined;
  if (b.dueAt !== undefined) {
    const t = typeof b.dueAt === 'string' ? Date.parse(b.dueAt) : NaN;
    if (Number.isNaN(t)) return bad(res, '"dueAt" must be an ISO date.');
    dueAt = new Date(t).toISOString();
  }
  const related: { id: string; rel: string }[] = [];
  if (b.related !== undefined) {
    if (!Array.isArray(b.related)) return bad(res, '"related" must be an array of {id, rel}.');
    for (const r of b.related as Record<string, unknown>[]) {
      if (typeof r?.id !== 'string' || !get(r.id)) return bad(res, `Related id ${String(r?.id)} does not exist.`);
      related.push({ id: r.id, rel: typeof r.rel === 'string' && r.rel.trim() ? r.rel.trim().slice(0, 40) : 'related' });
    }
  }
  const draft: EntityDraft = {
    type: b.type, name: b.name, aliases, facts,
    email: b.email as string | undefined, phone: b.phone as string | undefined, dueAt,
    status: b.status as EntityDraft['status'], related,
  };
  try {
    const r = upsert(draft, 'manual');
    res.status(r.created ? 201 : 200).json(r);
  } catch (err) {
    bad(res, errorText(err));
  }
});

assistantRouter.post('/memory/:id/link', (req: Request, res: Response) => {
  const { to, rel } = (req.body ?? {}) as { to?: unknown; rel?: unknown };
  if (typeof to !== 'string' || !get(to)) return bad(res, '"to" must be an existing entity id.');
  if (!get(req.params.id)) return void res.status(404).json({ error: 'No entity with that id.' });
  res.json({ linked: link(req.params.id, to, typeof rel === 'string' ? rel.slice(0, 40) : 'related'), entity: get(req.params.id) });
});

assistantRouter.post('/memory/:id/status', (req: Request, res: Response) => {
  const status = (req.body ?? {}).status;
  if (!isEntityStatus(status)) return bad(res, `"status" must be one of: ${ENTITY_STATUSES.join(', ')}.`);
  const e = setStatus(req.params.id, status);
  if (!e) return void res.status(404).json({ error: 'No entity with that id.' });
  res.json({ entity: e });
});

assistantRouter.delete('/memory/:id', (req: Request, res: Response) => {
  if (!remove(req.params.id)) return void res.status(404).json({ error: 'No entity with that id.' });
  res.json({ ok: true });
});

/* ── Chat ── */

assistantRouter.get('/chat', (_req: Request, res: Response) => {
  res.json({ history: getHistory() });
});

assistantRouter.post('/chat', async (req: Request, res: Response) => {
  const { message, model } = (req.body ?? {}) as { message?: unknown; model?: unknown };
  if (typeof message !== 'string' || !message.trim()) return bad(res, '"message" is required.');
  if (message.length > 20_000) return bad(res, '"message" is too long (max 20,000 characters).');
  if (model !== undefined && typeof model !== 'string') return bad(res, '"model" must be a string such as "anthropic:claude-...".');
  try {
    res.json(await chat(message, { model: model || undefined }));
  } catch (err) {
    res.status(500).json({ error: errorText(err) });
  }
});

/* ── Notifications ── */

assistantRouter.get('/notifications', (req: Request, res: Response) => {
  const unreadOnly = ['1', 'true'].includes(String(req.query.unread ?? ''));
  res.json({ notifications: listNotifications({ unreadOnly }), unread: unreadCount() });
});

assistantRouter.post('/notifications/read', (req: Request, res: Response) => {
  const id = (req.body ?? {}).id;
  if (typeof id !== 'string' || !id) return bad(res, '"id" must be a notification id or "all".');
  res.json({ changed: markRead(id), unread: unreadCount() });
});

assistantRouter.get('/notifications/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write('retry: 5000\n\n');
  send('hello', { unread: unreadCount() });
  const unsubscribe = subscribe((n, change) => send(change === 'created' ? 'notification' : 'notification.updated', n));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  heartbeat.unref();
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
  res.on('error', cleanup);
});

/* ── Inbound webhook (mounted separately, outside the local guard) ── */

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const assistantWebhookRouter = Router();

assistantWebhookRouter.post('/events', async (req: Request, res: Response) => {
  const expected = envValue('ASSISTANT_WEBHOOK_SECRET');
  if (!expected) {
    res.status(503).json({ error: 'Set ASSISTANT_WEBHOOK_SECRET under Environment, then send it from Lindy/Zapier/Make as "Authorization: Bearer <secret>" or an "x-webhook-secret" header.' });
    return;
  }
  const auth = String(req.headers.authorization ?? '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-webhook-secret'] ?? '');
  if (!given || !secretMatches(given, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const body = req.body as unknown;
  const raw = Array.isArray((body as { events?: unknown })?.events) ? (body as { events: unknown[] }).events : [body];
  if (!raw.length) return bad(res, 'No events in the request.');
  if (raw.length > MAX_EVENTS) return bad(res, `Send at most ${MAX_EVENTS} events per request.`);
  const parsed = raw.map(parseEvent);
  const errors = parsed.flatMap((p, i) => ('error' in p ? [{ index: i, error: p.error }] : []));
  if (errors.length === parsed.length) {
    res.status(400).json({ error: errors.length === 1 ? errors[0].error : 'No valid events.', errors });
    return;
  }
  const results: (EventOutcome | { index: number; error: string })[] = [];
  for (const [i, p] of parsed.entries()) {
    if ('error' in p) { results.push({ index: i, error: p.error }); continue; }
    try {
      results.push(await handleEvent(p.event));
    } catch (err) {
      results.push({ index: i, error: errorText(err) });
    }
  }
  res.json({ ok: true, processed: parsed.length - errors.length, results });
});
