import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { analyzeEmail } from './email.js';
import { checkDomain, parseAggregateReport } from './dmarc.js';
import { queryEvents, emit, allEvents } from './events.js';
import { getPolicy, updatePolicy } from './guardrails.js';
import { behaviorSettings, clearIntervention, riskScores, setIntervention, updateBehavior } from './behavior.js';
import { addHold, applyRetention, capture, exportRecords, governanceStatus, releaseHold, search, updateGovernance } from './governance.js';
import { incidents, eventsFor, retriage, review, setStatus } from './threat.js';
import { inventory } from './inventory.js';
import { scan } from './detectors.js';
import { ask } from '../llm/index.js';
import { toolAccessStats, searchTools } from '../tools/progressive.js';
import { listSkills, loadSkill } from '../tools/skills.js';
import { runCode } from '../tools/codeexec.js';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(/not found/i.test(msg) ? 404 : 400).json({ error: msg });
  }
};

export const securityRouter = Router();

securityRouter.get('/overview', h(async () => {
  const day = Date.now() - 86_400_000;
  const recent = allEvents().filter((e) => e.at >= day);
  const inv = await inventory();
  const inc = incidents();
  const byKind = recent.reduce<Record<string, number>>((m, e) => { m[e.kind] = (m[e.kind] ?? 0) + 1; return m; }, {});
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const start = Date.now() - (24 - i) * 3_600_000;
    return recent.filter((e) => e.at >= start && e.at < start + 3_600_000).length;
  });
  return {
    posture: inv.score,
    openIncidents: inc.incidents.filter((i) => i.status !== 'resolved').length,
    criticalOpen: inc.incidents.filter((i) => i.status !== 'resolved' && i.severity === 'critical').length,
    events24h: recent.length,
    redacted24h: recent.filter((e) => e.action === 'redacted').length,
    blocked24h: recent.filter((e) => e.action === 'blocked').length,
    byKind,
    hourly,
    topFindings: inv.findings.slice(0, 5),
    riskiest: riskScores().slice(0, 5),
    lastReviewAt: inc.lastRunAt,
    policy: getPolicy(),
  };
}));

securityRouter.get('/events', h((req) => queryEvents({
  kind: req.query.kind ? String(req.query.kind) : undefined,
  actor: req.query.actor ? String(req.query.actor) : undefined,
  minSeverity: req.query.min ? String(req.query.min) as never : undefined,
  limit: Math.min(1000, Number(req.query.limit) || 200),
})));

securityRouter.get('/inventory', h(() => inventory()));
securityRouter.get('/policy', h(() => getPolicy()));
securityRouter.put('/policy', h((req) => updatePolicy(req.body ?? {})));
securityRouter.post('/scan-text', h((req) => {
  const text = String(req.body?.text ?? '');
  if (!text) throw new Error('text is required');
  return { findings: scan(text) };
}));

securityRouter.post('/email', h(async (req) => {
  const raw = String(req.body?.raw ?? '');
  const report = analyzeEmail(raw);
  const messageId = raw.match(/^message-id:\s*(.+)$/im)?.[1]?.trim() ?? randomUUID();
  capture('email', 'email-analyzer', report.subject || '(no subject)', `From: ${report.from.name} <${report.from.address}>\nVerdict: ${report.verdict} (${report.score})\n${report.signals.map((s) => `- ${s.title}: ${s.detail}`).join('\n')}`, { messageId });
  if (report.verdict !== 'clean') {
    const sev = report.verdict === 'malicious' ? (report.signals.some((s) => s.severity === 'critical') ? 'critical' : 'high') : 'medium';
    emit({ kind: 'email_threat', severity: sev, actor: `email:${report.from.domain || 'unknown'}`, source: 'email analyzer', summary: `${report.verdict} email from ${report.from.address}: ${report.subject}`, action: 'logged', details: { messageId, subject: report.subject, signals: report.signals.map((s) => s.id) } });
  }
  let ai: { model: string; opinion: string } | { error: string } | undefined;
  if (req.body?.ai) {
    try {
      const r = await ask('SECURITY', `You are an email security analyst. Give a second opinion in under 120 words on whether this email is phishing or impersonation, citing the strongest evidence. Heuristic verdict: ${report.verdict} (score ${report.score}). Signals: ${report.signals.map((s) => `${s.title} (${s.detail})`).join('; ') || 'none'}.\n\nFrom: ${report.from.name} <${report.from.address}>\nReply-To: ${report.replyTo ?? '-'}\nSubject: ${report.subject}\nLinks: ${report.links.slice(0, 10).map((l) => `${l.text || '(no text)'} -> ${l.host}`).join('; ')}\n\nBody excerpt:\n${raw.split(/\r?\n\r?\n/).slice(1).join('\n\n').replace(/<[^>]+>/g, ' ').slice(0, 3_000)}`, { maxTokens: 1_000 });
      ai = { model: r.spec, opinion: r.text };
    } catch (err) {
      ai = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ...report, ai };
}));

securityRouter.post('/dmarc/check', h(async (req) => {
  const r = await checkDomain(String(req.body?.domain ?? ''));
  if (['D', 'F'].includes(r.grade)) {
    emit({ kind: 'dmarc', severity: r.grade === 'F' ? 'high' : 'medium', actor: `domain:${r.domain}`, source: 'dmarc analyzer', summary: `${r.domain} scored ${r.grade}: ${r.checks.filter((c) => c.status === 'fail').map((c) => c.title).join(', ')}`, action: 'logged', details: { domain: r.domain, grade: r.grade } });
  }
  return r;
}));
securityRouter.post('/dmarc/report', h((req) => parseAggregateReport(String(req.body?.xml ?? ''))));

securityRouter.get('/behavior', h(() => ({ ...behaviorSettings(), actors: riskScores() })));
securityRouter.put('/behavior', h((req) => updateBehavior(req.body ?? {})));
securityRouter.post('/behavior/intervene', h((req) => {
  const { actor, level, reason } = req.body ?? {};
  if (!actor || !['coach', 'review', 'restrict'].includes(level)) throw new Error('actor and level (coach, review or restrict) are required');
  return setIntervention(String(actor), level, String(reason || 'Set manually'));
}));
securityRouter.post('/behavior/clear', h((req) => { clearIntervention(String(req.body?.actor ?? '')); return { cleared: true }; }));

securityRouter.get('/governance', h(() => governanceStatus()));
securityRouter.put('/governance', h((req) => updateGovernance(req.body ?? {})));
securityRouter.get('/governance/search', h((req) => search({
  text: req.query.q ? String(req.query.q) : undefined,
  kind: req.query.kind ? String(req.query.kind) : undefined,
  actor: req.query.actor ? String(req.query.actor) : undefined,
  since: req.query.since ? Number(req.query.since) : undefined,
  limit: Math.min(500, Number(req.query.limit) || 100),
})));
securityRouter.get('/governance/export', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.send(exportRecords({ text: req.query.q ? String(req.query.q) : undefined, kind: req.query.kind ? String(req.query.kind) : undefined }));
});
securityRouter.post('/governance/holds', h((req) => addHold(String(req.body?.name ?? ''), Array.isArray(req.body?.terms) ? req.body.terms.map(String) : String(req.body?.terms ?? '').split(','))));
securityRouter.delete('/governance/holds/:id', h((req) => { releaseHold(req.params.id); return { released: true }; }));
securityRouter.post('/governance/retention', h(() => applyRetention()));

securityRouter.get('/incidents', h(() => incidents()));
securityRouter.post('/incidents/review', h(() => review()));
securityRouter.get('/incidents/:id/events', h((req) => eventsFor(req.params.id)));
securityRouter.post('/incidents/:id/status', h((req) => setStatus(req.params.id, req.body?.status, req.body?.note)));
securityRouter.post('/incidents/:id/triage', h((req) => retriage(req.params.id)));

securityRouter.get('/tools', h(async () => ({ ...(await toolAccessStats()), mode: getPolicy().toolAccess, codeExecution: getPolicy().codeExecution, skills: listSkills() })));
securityRouter.get('/tools/search', h((req) => searchTools(String(req.query.q ?? ''), Math.min(15, Number(req.query.limit) || 6))));
securityRouter.get('/skills/:name', h((req) => ({ name: req.params.name, content: loadSkill(req.params.name) })));
securityRouter.post('/tools/run-code', h((req) => runCode(String(req.body?.code ?? ''), 'IDE-user')));

