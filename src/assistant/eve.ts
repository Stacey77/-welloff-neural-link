import { LlmSession, type ChatMessage } from '../llm/index.js';
import { contextEntities, describe, formatDue, relevantEntities, summary, upcomingDeadlines, type Entity, type EntityType } from './memory.js';
import { rememberText } from './extract.js';
import { list as listNotifications } from './notify.js';
import { isObject, persisted } from './store.js';

export interface Turn { at: string; message: ChatMessage; model?: string }

export interface ChatReply {
  reply: string;
  model: string | null;
  remembered: { type: EntityType; name: string; fact: string }[];
  usedContext: string[];
  note?: string;
}

const MAX_TURNS = 40;

const history = persisted<{ turns: Turn[] }>(
  'conversation.json',
  () => ({ turns: [] }),
  (v): v is { turns: Turn[] } => isObject(v) && Array.isArray(v.turns),
);

const PERSONA = [
  'You are EVE, the personal operations assistant of a business owner who runs several LLCs.',
  'You keep track of their companies, clients, projects, people, prospects, deadlines and bookings.',
  'Be concise and proactive: lead with the answer, then flag anything due soon, overdue, or waiting on a reply.',
  'Use only the memory below and this conversation. Never invent names, amounts, dates or commitments.',
  'If memory does not cover the question, say plainly that you do not know and ask for the detail.',
  'New facts the owner tells you are saved to memory automatically after you reply.',
].join('\n');

function systemPrompt(message: string, ctx: Entity[], now: number): string {
  const s = summary(now);
  const unread = listNotifications({ unreadOnly: true, limit: 5 });
  return [
    PERSONA,
    '',
    `Now: ${new Date(now).toString()}.`,
    `Memory holds ${s.total} entries (${Object.entries(s.counts).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).join(', ') || 'none'}).`,
    '',
    'Relevant memory:',
    ctx.length ? ctx.map((e) => describe(e, now, 4)).join('\n') : '(nothing relevant on file)',
    ...(unread.length ? ['', 'Unread alerts:', ...unread.map((n) => `- ${n.title}`)] : []),
  ].join('\n');
}

function trimmed(turns: Turn[]): Turn[] {
  const out = turns.slice(-MAX_TURNS);
  while (out.length && out[0].message.role !== 'user') out.shift();
  return out;
}

function memoryLine(e: Entity, now: number): string {
  const bits = [`${e.name} (${e.type}${e.status && e.status !== 'open' ? `, ${e.status}` : ''})`];
  if (e.dueAt) bits.push(`due ${formatDue(e.dueAt, now)}`);
  if (e.email) bits.push(e.email);
  const fact = e.facts[e.facts.length - 1]?.text;
  return `- ${bits.join(', ')}${fact ? `: ${fact}` : ''}`;
}

function memoryAnswer(message: string, now: number): string {
  const direct = relevantEntities(message, 8, now);
  const soon = upcomingDeadlines(14, now).filter((d) => !direct.some((e) => e.id === d.id));
  if (!direct.length && !soon.length) return `I have nothing in memory about that yet. Tell me the details and I'll remember them.`;
  const order: Record<EntityType, number> = { deadline: 0, booking: 1, client: 2, prospect: 3, project: 4, llc: 5, person: 6, note: 7 };
  const asksWhen = /\b(when|due|deadline|owe|schedule|next|soon)\b/i.test(message);
  const sorted = asksWhen ? [...direct].sort((a, b) => order[a.type] - order[b.type]) : direct;
  const parts = [direct.length ? `Here is what I have in memory:\n${sorted.map((e) => memoryLine(e, now)).join('\n')}` : 'I found nothing in memory that matches that.'];
  if (soon.length) parts.push(`Also coming up:\n${soon.slice(0, 5).map((e) => memoryLine(e, now)).join('\n')}`);
  return parts.join('\n\n');
}

export async function chat(message: string, opts: { model?: string; now?: number } = {}): Promise<ChatReply> {
  const text = message.trim();
  if (!text) throw new Error('Send a message.');
  const now = opts.now ?? Date.now();
  const ctx = contextEntities(text, 12, now);
  const data = history.get();
  const userTurn: Turn = { at: new Date(now).toISOString(), message: { role: 'user', content: text } };

  let reply: string;
  let model: string | null = null;
  let note: string | undefined;
  let assistant: ChatMessage;
  try {
    const session = new LlmSession('EVE', text, opts.model);
    const r = await session.turn({ system: systemPrompt(text, ctx, now), messages: [...trimmed(data.turns).map((t) => t.message), userTurn.message], maxTokens: 1024 });
    reply = r.text.trim() || '(no reply)';
    model = r.spec;
    assistant = r.assistant;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note = /no (llm provider|model) is (configured|available)|api key|authentication|apikey|authtoken/i.test(msg)
      ? 'No language model is configured, so this answer comes straight from memory. Add a provider key under Models to chat normally.'
      : `The model call failed (${msg.slice(0, 160)}), so this answer comes straight from memory.`;
    reply = `${memoryAnswer(text, now)}\n\n${note}`;
    assistant = { role: 'assistant', text: reply, toolCalls: [] };
  }

  data.turns = trimmed([...data.turns, userTurn, { at: new Date().toISOString(), message: assistant, ...(model ? { model } : {}) }]);
  history.save();

  let remembered: ChatReply['remembered'] = [];
  try {
    remembered = (await rememberText(text, { source: 'chat', now, useLlm: model !== null, model: opts.model })).remembered;
  } catch (err) {
    console.error('[assistant] could not save memory from chat:', err instanceof Error ? err.message : err);
  }
  return { reply, model, remembered, usedContext: ctx.map((e) => e.id), ...(note ? { note } : {}) };
}

export function getHistory(): { role: 'user' | 'assistant'; text: string; at: string; model?: string }[] {
  return history.get().turns
    .filter((t) => t.message.role !== 'tool')
    .map((t) => ({ role: t.message.role as 'user' | 'assistant', text: t.message.role === 'user' ? t.message.content : t.message.role === 'assistant' ? t.message.text : '', at: t.at, ...(t.model ? { model: t.model } : {}) }));
}

export function clearHistory(): void {
  history.set({ turns: [] });
}
