export type Category = 'secret' | 'pii' | 'injection';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  category: Category;
  type: string;
  severity: Severity;
  start: number;
  end: number;
  preview: string;
}

interface Pattern { type: string; re: RegExp; severity: Severity; check?: (m: string) => boolean }

const SECRET: Pattern[] = [
  { type: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, severity: 'critical' },
  { type: 'openai_key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, severity: 'critical' },
  { type: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: 'critical' },
  { type: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, severity: 'critical' },
  { type: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: 'high' },
  { type: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, severity: 'high' },
  { type: 'stripe_live_key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, severity: 'critical' },
  { type: 'private_key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |)PRIVATE KEY-----/g, severity: 'critical' },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, severity: 'high' },
  { type: 'credential_assignment', re: /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/gi, severity: 'high' },
];

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

const PII: Pattern[] = [
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, severity: 'low' },
  { type: 'us_ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, severity: 'high' },
  { type: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/g, severity: 'high', check: luhn },
  { type: 'phone', re: /(?<![\w.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, severity: 'low' },
  { type: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, severity: 'medium' },
];

const INJECTION: Pattern[] = [
  { type: 'override_instructions', re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|system|all)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|guidelines)\b/gi, severity: 'high' },
  { type: 'role_hijack', re: /\byou are now\b[^.\n]{0,40}\b(?:DAN|jailbroken|developer mode|unrestricted|no longer bound)\b/gi, severity: 'high' },
  { type: 'prompt_exfiltration', re: /\b(?:reveal|print|repeat|show|output)\b[^.\n]{0,30}\b(?:system prompt|hidden instructions|your instructions|developer message)\b/gi, severity: 'medium' },
  { type: 'credential_exfiltration', re: /\b(?:send|post|upload|forward|email|exfiltrate)\b[^.\n]{0,40}\b(?:api keys?|secrets?|credentials?|tokens?|passwords?|\.env)\b[^.\n]{0,40}\b(?:to|at)\b/gi, severity: 'critical' },
  { type: 'fake_system_tag', re: /<\s*\/?\s*(?:system|im_start|im_end|assistant|developer)\s*>|\[\s*(?:SYSTEM|INST)\s*\]|BEGIN (?:SYSTEM|ADMIN) (?:PROMPT|OVERRIDE)/gi, severity: 'medium' },
  { type: 'tool_coercion', re: /\b(?:call|use|invoke|run)\b[^.\n]{0,20}\b(?:the )?(?:propose_edit|trigger_lindy|dispatch_agent|run_code|call_tool)\b[^.\n]{0,60}\b(?:immediately|now|without (?:asking|review|confirmation))\b/gi, severity: 'high' },
  { type: 'hidden_unicode', re: /[\u{E0000}-\u{E007F}]{3,}|[​-‏⁠-⁤]{4,}/gu, severity: 'high' },
];

function mask(s: string): string {
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-2)}`;
}

function run(text: string, category: Category, patterns: Pattern[]): Finding[] {
  const out: Finding[] = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (p.check && !p.check(m[0])) continue;
      const start = m.index ?? 0;
      out.push({
        category, type: p.type, severity: p.severity, start, end: start + m[0].length,
        preview: category === 'injection' ? m[0].slice(0, 80) : mask(m[0]),
      });
    }
  }
  return out;
}

export function scan(text: string, categories: Category[] = ['secret', 'pii', 'injection']): Finding[] {
  if (!text) return [];
  const found: Finding[] = [];
  if (categories.includes('secret')) found.push(...run(text, 'secret', SECRET));
  if (categories.includes('pii')) found.push(...run(text, 'pii', PII));
  if (categories.includes('injection')) found.push(...run(text, 'injection', INJECTION));
  // A secret also matching a PII pattern (e.g. digits) is reported once, as the secret.
  return found
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((f, i, arr) => !arr.some((g, j) => j < i && g.start <= f.start && g.end >= f.end && g.category !== 'injection' && f.category !== 'injection'));
}

export function redact(text: string, findings: Finding[]): string {
  let out = text;
  for (const f of [...findings].filter((x) => x.category !== 'injection').sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, f.start)}[REDACTED:${f.type}]${out.slice(f.end)}`;
  }
  return out;
}

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
export function maxSeverity(findings: Finding[]): Severity | null {
  return findings.reduce<Severity | null>((m, f) => (!m || RANK[f.severity] > RANK[m] ? f.severity : m), null);
}
export function severityRank(s: Severity): number {
  return RANK[s];
}
