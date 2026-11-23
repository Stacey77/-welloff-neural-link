import type { AgentCommand } from '../types/index.js';
import { chat } from '../assistant/eve.js';
import { rememberText } from '../assistant/extract.js';
import { contextFor, isEntityType, list, search, summary, ENTITY_TYPES, type EntityType } from '../assistant/memory.js';
import { list as listNotifications, unreadCount } from '../assistant/notify.js';
import { handleEvent, parseEvent, runWatchOnce } from '../assistant/watch.js';

const text = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`EVE: "${field}" is required.`);
  return v;
};

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;

  switch (command.command) {
    case 'chat':
      return chat(text(p.message, 'message'), { model: typeof p.model === 'string' ? p.model : undefined });

    case 'remember': {
      const r = await rememberText(text(p.text, 'text'), { source: 'manual' });
      return { remembered: r.remembered, via: r.extraction.via, entities: r.entities.map((e) => ({ id: e.id, type: e.type, name: e.name })) };
    }

    case 'recall': {
      const query = text(p.query, 'query');
      return { hits: search(query, { limit: 10 }).map((h) => ({ score: Math.round(h.score), entity: h.entity })), context: contextFor(query) };
    }

    case 'list': {
      if (p.type !== undefined && !isEntityType(p.type)) throw new Error(`EVE: type must be one of ${ENTITY_TYPES.join(', ')}.`);
      return { entities: list({ type: p.type as EntityType | undefined }), summary: summary() };
    }

    case 'notifications':
      return { notifications: listNotifications({ unreadOnly: Boolean(p.unread) }), unread: unreadCount() };

    case 'event': {
      const parsed = parseEvent(p.event ?? p);
      if ('error' in parsed) throw new Error(`EVE: ${parsed.error}`);
      return handleEvent(parsed.event);
    }

    case 'watch':
      return { fired: runWatchOnce() };

    default:
      throw new Error(`EVE: unknown command "${command.command}"`);
  }
}
