import { Router, type Request, type Response } from 'express';
import { randomUUID, timingSafeEqual } from 'crypto';
import { envValue } from '../llm/catalog.js';
import { route } from '../core/router.js';
import { AgentIdSchema } from '../types/index.js';
import { scan, redact } from '../security/detectors.js';
import { emit } from '../security/events.js';
import { capture } from '../security/governance.js';
import { getPolicy } from '../security/guardrails.js';

// Outbound: LINDY_WEBHOOK_URL is the URL of a Lindy agent's "Webhook received" trigger.
// Inbound: Lindy's HTTP Request action calls POST /integrations/lindy with LINDY_INBOUND_SECRET.

export function lindyStatus() {
  return {
    outbound: Boolean(envValue('LINDY_WEBHOOK_URL')),
    inbound: Boolean(envValue('LINDY_INBOUND_SECRET')),
    inboundPath: '/integrations/lindy',
  };
}

export async function trigger(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const url = envValue('LINDY_WEBHOOK_URL');
  if (!url) throw new Error('Add LINDY_WEBHOOK_URL (the URL of your Lindy agent\'s webhook trigger) under Environment.');
  const secret = envValue('LINDY_WEBHOOK_SECRET');
  let outBody = JSON.stringify({ source: 'neural-link', ...payload });
  const leaks = getPolicy().secret === 'off' ? [] : scan(outBody, ['secret']);
  if (leaks.length) {
    if (getPolicy().secret === 'block') {
      emit({ kind: 'secret', severity: 'critical', actor: 'LINDY', source: 'outbound webhook', summary: `Blocked a Lindy webhook containing ${leaks.length} secret(s)`, action: 'blocked' });
      throw new Error('Blocked by data protection policy: the Lindy payload contains secrets.');
    }
    if (getPolicy().secret === 'redact') outBody = redact(outBody, leaks);
    emit({ kind: 'secret', severity: 'high', actor: 'LINDY', source: 'outbound webhook', summary: `${getPolicy().secret === 'redact' ? 'Redacted' : 'Detected'} ${leaks.length} secret(s) in a Lindy webhook`, action: getPolicy().secret === 'redact' ? 'redacted' : 'logged' });
  }
  capture('lindy_out', 'LINDY', 'Webhook to Lindy', outBody.slice(0, 8_000));
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: outBody,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* plain text reply */ }
  if (!r.ok) throw new Error(`Lindy webhook returned ${r.status}: ${text.slice(0, 200)}`);
  return { status: r.status, body };
}

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const lindyRouter = Router();

lindyRouter.post('/', async (req: Request, res: Response) => {
  const expected = envValue('LINDY_INBOUND_SECRET');
  if (!expected) {
    res.status(503).json({ error: 'Set LINDY_INBOUND_SECRET under Environment to accept calls from Lindy.' });
    return;
  }
  const auth = String(req.headers.authorization ?? '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-lindy-secret'] ?? '');
  if (!secretMatches(given, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  capture('lindy_in', 'lindy', 'Inbound call from Lindy', JSON.stringify(body).slice(0, 8_000));
  try {
    const agentId = body.agentId ? AgentIdSchema.parse(String(body.agentId).toUpperCase()) : 'TON';
    const command = String(body.command ?? 'dispatch');
    const params = { ...((body.params as Record<string, unknown>) ?? {}), ...(body.message ? { message: String(body.message) } : {}) };
    if (agentId === 'TON' && !params.message) throw new Error('Send a message, or an agentId and command.');
    const result = await route({ id: randomUUID(), agentId, command, params, timestamp: Date.now() });
    res.json({ ok: true, agentId, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
