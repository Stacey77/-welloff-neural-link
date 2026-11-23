import { randomUUID } from 'crypto';
import { trigger as triggerLindy, lindyStatus } from '../integrations/lindy.js';
import { isObject, persisted } from './store.js';

export const NOTIFICATION_KINDS = ['booking', 'deadline_soon', 'deadline_due', 'overdue', 'prospect_reply', 'info'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entityIds: string[];
  at: string;
  read: boolean;
  key?: string;
  delivered: { lindy?: 'sent' | 'failed' | 'skipped'; error?: string };
}

export interface NotifyInput { kind: NotificationKind; title: string; body?: string; entityIds?: string[]; key?: string; at?: number }

interface NotifyFile { items: Notification[]; keys: Record<string, string> }

const MAX_ITEMS = 500;
const MAX_KEYS = 5_000;

const store = persisted<NotifyFile>(
  'notifications.json',
  () => ({ items: [], keys: {} }),
  (v): v is NotifyFile => isObject(v) && Array.isArray(v.items) && isObject(v.keys),
);

type Listener = (n: Notification, change: 'created' | 'updated') => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(n: Notification, change: 'created' | 'updated'): void {
  for (const fn of [...listeners]) {
    try { fn(n, change); } catch (err) { console.error('[assistant] notification listener failed:', err instanceof Error ? err.message : err); }
  }
}

export function hasKey(key: string): boolean {
  return key in store.get().keys;
}

/** Records a notification and sends it to Lindy when configured. Returns null if `key` was already notified. */
export function notify(input: NotifyInput): Notification | null {
  const data = store.get();
  if (input.key && data.keys[input.key]) return null;
  const at = new Date(input.at ?? Date.now()).toISOString();
  const outbound = lindyStatus().outbound;
  const n: Notification = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: (input.body ?? '').slice(0, 2_000),
    entityIds: input.entityIds ?? [],
    at,
    read: false,
    ...(input.key ? { key: input.key } : {}),
    delivered: outbound ? {} : { lindy: 'skipped' },
  };
  data.items.push(n);
  if (data.items.length > MAX_ITEMS) data.items.splice(0, data.items.length - MAX_ITEMS);
  if (input.key) {
    data.keys[input.key] = at;
    const keys = Object.keys(data.keys);
    if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete data.keys[k];
  }
  store.save();
  emit(n, 'created');
  if (outbound) void deliver(n);
  return n;
}

async function deliver(n: Notification): Promise<void> {
  try {
    await triggerLindy({ type: 'eve.notification', notification: { id: n.id, kind: n.kind, title: n.title, body: n.body, at: n.at, entityIds: n.entityIds } });
    n.delivered = { lindy: 'sent' };
  } catch (err) {
    n.delivered = { lindy: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
  store.save();
  emit(n, 'updated');
}

export function list(opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
  const items = store.get().items.filter((n) => !opts.unreadOnly || !n.read);
  return items.slice(-(opts.limit ?? 100)).reverse();
}

export function unreadCount(): number {
  return store.get().items.filter((n) => !n.read).length;
}

/** Marks one notification (or 'all') read; returns how many changed. */
export function markRead(id: string): number {
  let changed = 0;
  for (const n of store.get().items) {
    if ((id === 'all' || n.id === id) && !n.read) { n.read = true; changed++; }
  }
  if (changed) store.save();
  return changed;
}

export function flushNotifications(): void {
  store.flush();
}
