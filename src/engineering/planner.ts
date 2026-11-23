import { ask } from '../llm/index.js';
import type { ComponentSpec, GeometryType, Loads, Plan, Priority, ProjectOptions, SupportType } from './types.js';

const G = 9.81;
const NUM = '(-?\\d+(?:\\.\\d+)?)';

const GEOMETRY_WORDS: [GeometryType, RegExp][] = [
  ['pressure_vessel', /pressure vessel|\btank\b|\bvessel\b|\breceiver\b|\bboiler\b|\bcylinder\b/i],
  ['shaft', /\bshaft\b|\baxle\b|\bspindle\b/i],
  ['bracket', /\bbracket\b|\bcantilever(ed)?\b|wall[- ]mount|\bmount(ing)?\b|\bshelf\b|\barm\b/i],
  ['plate', /\bplate\b|\bpanel\b|\bdeck\b|\bcover\b/i],
  ['frame', /\bframe\b|\btruss\b|\bchassis\b|\brack\b|\bstand\b/i],
  ['beam', /\bbeam\b|\bgirder\b|\bjoist\b|\blintel\b|\brail\b|\bbar\b/i],
];

const LABEL: Record<GeometryType, string> = {
  bracket: 'Bracket', beam: 'Beam', shaft: 'Shaft', plate: 'Plate', pressure_vessel: 'Pressure vessel', frame: 'Frame member',
};

function defaultSupport(g: GeometryType, text: string): SupportType {
  if (/fixed[- ]fixed|fixed (at )?both ends|built[- ]in|encastr/i.test(text)) return 'fixed_fixed';
  if (/simply[- ]supported|pinned|between (two )?(supports|walls|posts|bearings)|spanning/i.test(text) && g !== 'bracket') return 'simply_supported';
  if (/cantilever/i.test(text) || g === 'bracket') return 'cantilever';
  if (g === 'frame') return 'fixed_fixed';
  return 'simply_supported';
}

function toMm(v: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('mm') || u.startsWith('milli')) return v;
  if (u === 'cm') return v * 10;
  return v * 1000;
}

// Words describing a dimension sit right next to it, within the same clause.
function context(text: string, idx: number, len: number): string {
  const before = text.slice(Math.max(0, idx - 20), idx).split(/[,;(]| and | with /).pop() ?? '';
  const after = text.slice(idx + len, idx + len + 14).split(/[,;)]| and | with /)[0] ?? '';
  return `${before} ${after}`.toLowerCase();
}

export interface RulesParse {
  plan: Plan;
  notes: string[];
}

export function rulesPlan(goal: string, opts: ProjectOptions = {}): RulesParse {
  let text = ` ${goal} `;
  const notes: string[] = [];
  const assumptions: string[] = [];
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) fn(m);
    text = text.replace(g, ' ');
  };

  let udl = 0, torque = 0, force = 0, massKg = 0, pressureMPa = 0, powerKw = 0, rpm = 0;
  let sf: number | undefined;
  const temps: number[] = [];
  const lengths: number[] = [];
  let widthMm: number | undefined, diameterMm: number | undefined;

  take(/(?:safety factor|factor of safety|\bsf|\bfos)\s*(?:of|=|:|≥|>=)?\s*(\d+(?:\.\d+)?)/i, (m) => { sf = Number(m[1]); });
  take(new RegExp(`${NUM}\\s*(kN|N)\\s*\\/\\s*m\\b`), (m) => { udl += Number(m[1]) * (m[2] === 'kN' ? 1000 : 1); });
  take(new RegExp(`${NUM}\\s*(kN|N)\\s*[·.*\\- ]?\\s*m\\b`), (m) => { torque += Number(m[1]) * (m[2] === 'kN' ? 1000 : 1); });
  take(new RegExp(`${NUM}\\s*(kW)\\b`, 'i'), (m) => { powerKw = Number(m[1]); });
  take(new RegExp(`${NUM}\\s*(rpm)\\b`, 'i'), (m) => { rpm = Number(m[1]); });
  take(new RegExp(`${NUM}\\s*(bar|MPa|kPa|psi)\\b`, 'i'), (m) => {
    const v = Number(m[1]), u = m[2].toLowerCase();
    pressureMPa = Math.max(pressureMPa, u === 'bar' ? v / 10 : u === 'kpa' ? v / 1000 : u === 'psi' ? v * 0.006895 : v);
  });
  take(new RegExp(`${NUM}\\s*(kN|N|newtons?)\\b`), (m) => { force += Number(m[1]) * (m[2] === 'kN' ? 1000 : 1); });
  take(new RegExp(`${NUM}\\s*(kg|kilograms?|tonnes?|tons?|t)\\b`, 'i'), (m) => {
    const u = m[2].toLowerCase();
    massKg += Number(m[1]) * (u.startsWith('k') ? 1 : 1000);
  });
  take(new RegExp(`${NUM}\\s*(?:°\\s*|º\\s*|deg(?:rees)?\\s*)?(C|F|celsius|fahrenheit)\\b`, 'i'), (m) => {
    const v = Number(m[1]);
    temps.push(/^f/i.test(m[2]) ? (v - 32) * 5 / 9 : v);
  });
  {
    const re = new RegExp(`${NUM}\\s*(mm|cm|m|millimet(?:re|er)s?|met(?:re|er)s?)\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const v = toMm(Number(m[1]), m[2]);
      const ctx = context(text, m.index, m[0].length);
      if (/diameter|\bdia\b|ø|bore|\bod\b/.test(ctx)) diameterMm ??= v;
      else if (/\bwide\b|width/.test(ctx)) widthMm ??= v;
      else if (/thick/.test(ctx)) notes.push(`ignored thickness ${v} mm (thickness is sized by the solver)`);
      else lengths.push(v);
    }
  }

  const pos = (g: GeometryType) => text.search(GEOMETRY_WORDS.find((x) => x[0] === g)![1]);
  const ordered = GEOMETRY_WORDS.filter(([, re]) => re.test(text)).map(([g]) => g).sort((a, b) => pos(a) - pos(b)).slice(0, 4);
  if (!ordered.length) { ordered.push('beam'); notes.push('no geometry keyword found: assumed a simply supported beam'); }

  const cyclic = /motor|vibrat|rotat|pump|\bfan\b|cyclic|fatigue|engine|compressor|rpm|oscillat|reciprocat/i.test(goal);
  const corrosive = /outdoor|marine|\bsea\b|salt|\bwet\b|washdown|corros|chemical|humid|offshore|food/i.test(goal);
  const hint = /stainless|titanium|alumin(i)?um|cast iron|ductile iron|carbon fib(re|er)|cfrp|peek|nylon|pa66|plastic|polymer|copper|steel/i.exec(goal)?.[0];
  const priority: Priority = opts.priority ?? (/lightweight|light[- ]weight|low mass|minimi[sz]e (mass|weight)/i.test(goal) ? 'mass' : /cheap|low[- ]cost|budget|economical/i.test(goal) ? 'cost' : 'balanced');
  const opTemp = temps.length ? Math.max(...temps) : 20;
  if (!temps.length) assumptions.push('no temperature given: 20 °C ambient assumed');
  if (rpm && powerKw && !torque) {
    torque = (powerKw * 1000) / (2 * Math.PI * rpm / 60);
    notes.push(`torque derived from ${powerKw} kW at ${rpm} rpm: ${torque.toFixed(1)} N·m`);
  }
  let totalN = force + massKg * G;
  if (massKg) notes.push(`${massKg} kg × 9.81 m/s² = ${(massKg * G).toFixed(1)} N`);
  const distributed = /uniform|distributed|\budl\b|along (its|the) length/i.test(goal);

  const components: ComponentSpec[] = ordered.map((g, i) => {
    const support = defaultSupport(g, goal);
    const length = lengths[i] ?? lengths[0] ?? (g === 'bracket' ? 300 : g === 'shaft' ? 400 : g === 'pressure_vessel' ? 1500 : 1000);
    if (lengths[i] === undefined && lengths[0] === undefined) assumptions.push(`${LABEL[g]}: no length given, ${length} mm assumed`);
    const loads: Loads = { pointN: 0, pointAtFrac: support === 'cantilever' ? 1 : 0.5, udlNPerM: 0, torqueNm: 0, pressureMPa: 0 };
    if (g === 'pressure_vessel') {
      loads.pressureMPa = pressureMPa || 1;
      if (!pressureMPa) assumptions.push('Pressure vessel: no pressure given, 1 MPa (10 bar) assumed');
    } else {
      if (g === 'shaft') loads.torqueNm = torque;
      if (g === 'plate' && pressureMPa) loads.pressureMPa = pressureMPa;
      if (distributed) loads.udlNPerM = totalN / (length / 1000) + udl;
      else { loads.pointN = totalN; loads.udlNPerM = udl; }
      if (!totalN && !udl && !loads.torqueNm && !loads.pressureMPa) {
        loads.pointN = 1000;
        totalN = 1000;
        assumptions.push(`${LABEL[g]}: no load given, 1 kN point load assumed`);
      }
    }
    return {
      id: `c${i + 1}`, name: LABEL[g], geometry: g, support, lengthMm: length,
      widthMm: g === 'plate' ? widthMm ?? 500 : widthMm,
      diameterMm: g === 'pressure_vessel' ? diameterMm ?? 500 : diameterMm,
      loads, operatingTempC: opTemp, cyclic, corrosive, materialHint: hint?.toLowerCase(), notes: [],
    };
  });

  const plan: Plan = {
    summary: `${components.map((c) => `${c.name} (${c.support.replace('_', ' ')}, ${c.lengthMm} mm)`).join(', ')} at ${opTemp} °C` + (hint ? `, ${hint.toLowerCase()} preferred` : ''),
    components,
    requirements: {
      targetSafetyFactor: opts.targetSafetyFactor ?? sf ?? 2,
      priority,
      dynamicFactor: cyclic ? 1.5 : 1,
      tempMarginC: 15,
      notes: [
        cyclic ? 'rotating/vibrating equipment: dynamic amplification factor 1.5 applied to service loads' : 'static loading assumed',
        corrosive ? 'corrosive environment: corrosion-resistant material or protection required' : 'indoor dry environment assumed',
      ],
    },
    assumptions,
  };
  return { plan, notes };
}

/* ── LLM planner ── */

const SYSTEM = [
  'You are AXIOM, a mechanical design architect. Convert an engineering goal into a structured architecture plan.',
  'Respond with JSON only, no prose and no code fences. Schema:',
  '{"summary":string,"components":[{"name":string,"geometry":"bracket|beam|shaft|plate|pressure_vessel|frame","support":"cantilever|simply_supported|fixed_fixed","lengthMm":number,"widthMm"?:number,"diameterMm"?:number,',
  '"loads":{"pointN":number,"pointAtFrac":number,"udlNPerM":number,"torqueNm":number,"pressureMPa":number},"operatingTempC":number,"cyclic":boolean,"corrosive":boolean,"materialHint"?:string,"notes":[string]}],',
  '"requirements":{"targetSafetyFactor":number,"priority":"mass|cost|balanced","notes":[string]},"assumptions":[string]}',
  'Loads are unfactored service loads in SI units: convert kg to N with g = 9.81. pointAtFrac is the load position as a fraction of length (1 = tip of a cantilever).',
  'Use 1 to 4 components. State every assumption you make. Do not size sections or choose materials: other agents do that.',
].join('\n');

export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in model output');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in model output');
}

const GEOMS: GeometryType[] = ['bracket', 'beam', 'shaft', 'plate', 'pressure_vessel', 'frame'];
const SUPPORTS: SupportType[] = ['cantilever', 'simply_supported', 'fixed_fixed'];

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
}

// Coerces model output into a valid plan; any missing or invalid field falls back to the rules parse.
export function normalizePlan(raw: unknown, fallback: Plan, opts: ProjectOptions = {}): Plan {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawComps = Array.isArray(r.components) ? r.components.slice(0, 4) : [];
  if (!rawComps.length) throw new Error('plan has no components');
  const fb0 = fallback.components[0];
  const components = rawComps.map((x, i): ComponentSpec => {
    const c = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const fb = fallback.components[i] ?? fb0;
    const geometry = GEOMS.includes(c.geometry as GeometryType) ? (c.geometry as GeometryType) : fb.geometry;
    const support = SUPPORTS.includes(c.support as SupportType) ? (c.support as SupportType) : defaultSupport(geometry, '');
    const l = (c.loads && typeof c.loads === 'object' ? c.loads : {}) as Record<string, unknown>;
    const loads: Loads = {
      pointN: num(l.pointN, fb.loads.pointN, 0, 1e8),
      pointAtFrac: num(l.pointAtFrac, support === 'cantilever' ? 1 : 0.5, 0, 1),
      udlNPerM: num(l.udlNPerM, fb.loads.udlNPerM, 0, 1e8),
      torqueNm: num(l.torqueNm, fb.loads.torqueNm, 0, 1e8),
      pressureMPa: num(l.pressureMPa, fb.loads.pressureMPa, 0, 500),
    };
    if (geometry === 'pressure_vessel' && !loads.pressureMPa) loads.pressureMPa = 1;
    if (geometry !== 'pressure_vessel' && !loads.pointN && !loads.udlNPerM && !loads.torqueNm && !loads.pressureMPa) loads.pointN = fb.loads.pointN || 1000;
    return {
      id: `c${i + 1}`,
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 80) : LABEL[geometry],
      geometry, support,
      lengthMm: num(c.lengthMm, fb.lengthMm, 10, 50_000),
      widthMm: c.widthMm !== undefined ? num(c.widthMm, 500, 5, 20_000) : geometry === 'plate' ? fb.widthMm ?? 500 : undefined,
      diameterMm: c.diameterMm !== undefined ? num(c.diameterMm, 500, 5, 20_000) : geometry === 'pressure_vessel' ? fb.diameterMm ?? 500 : undefined,
      loads,
      operatingTempC: num(c.operatingTempC, fb.operatingTempC, -100, 1200),
      cyclic: typeof c.cyclic === 'boolean' ? c.cyclic : fb.cyclic,
      corrosive: typeof c.corrosive === 'boolean' ? c.corrosive : fb.corrosive,
      materialHint: typeof c.materialHint === 'string' && c.materialHint ? c.materialHint.toLowerCase().slice(0, 40) : fb.materialHint,
      notes: strs(c.notes),
    };
  });
  const req = (r.requirements && typeof r.requirements === 'object' ? r.requirements : {}) as Record<string, unknown>;
  const pr = req.priority === 'mass' || req.priority === 'cost' || req.priority === 'balanced' ? req.priority : fallback.requirements.priority;
  const cyclic = components.some((c) => c.cyclic);
  return {
    summary: typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim().slice(0, 600) : fallback.summary,
    components,
    requirements: {
      targetSafetyFactor: opts.targetSafetyFactor ?? num(req.targetSafetyFactor, fallback.requirements.targetSafetyFactor, 1.1, 10),
      priority: opts.priority ?? pr,
      dynamicFactor: cyclic ? 1.5 : 1,
      tempMarginC: 15,
      notes: strs(req.notes).length ? strs(req.notes) : fallback.requirements.notes,
    },
    assumptions: strs(r.assumptions),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`LLM call timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface PlanOutcome {
  plan: Plan;
  source: 'llm' | 'rules';
  model?: string;
  notes: string[];
  llmAvailable: boolean;
}

export async function makePlan(goal: string, opts: ProjectOptions = {}): Promise<PlanOutcome> {
  const rules = rulesPlan(goal, opts);
  if (opts.llm === false) return { plan: rules.plan, source: 'rules', notes: ['LLM disabled for this run', ...rules.notes], llmAvailable: false };
  let reply: { text: string; spec: string };
  try {
    reply = await withTimeout(ask('AXIOM', `Engineering goal:\n${goal}`, { system: SYSTEM, maxTokens: 2_000, model: opts.model }), 90_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { plan: rules.plan, source: 'rules', notes: [`LLM planner unavailable (${msg.slice(0, 200)}); used the rules planner`, ...rules.notes], llmAvailable: false };
  }
  try {
    const plan = normalizePlan(extractJson(reply.text), rules.plan, opts);
    return { plan, source: 'llm', model: reply.spec, notes: [`plan drafted by ${reply.spec}, validated against the rules parse`], llmAvailable: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { plan: rules.plan, source: 'rules', notes: [`LLM output from ${reply.spec} could not be parsed (${msg}); used the rules planner`, ...rules.notes], llmAvailable: true };
  }
}

export { withTimeout };
