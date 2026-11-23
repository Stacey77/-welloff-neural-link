import { ask } from '../llm/index.js';
import { traced } from '../integrations/langsmith.js';
import { analyze, massKg, primaryLoad, round, thermalRestraint, ASSEMBLY_TEMP_C } from './analysis.js';
import { sectionProps } from './fea.js';
import { getMaterial, hintFamilies, selectMaterials, yieldAt, type Material, type MaterialChoice } from './materials.js';
import { makePlan, withTimeout } from './planner.js';
import type { ChannelDef, ComponentDesign, ComponentSpec, Finding, NodeStatus, Plan, ProjectOptions, Section, SectionShape, SwarmNodeRun } from './types.js';

export interface SwarmState {
  goal: string;
  opts: ProjectOptions;
  plan?: Plan;
  planSource: 'llm' | 'rules';
  planModel?: string;
  planNotes: string[];
  llmAvailable: boolean;
  architecture: { componentId: string; role: string; analysis: string }[];
  designLoads: Record<string, { dynamicFactor: number; serviceLoad: number; designLoad: number; unit: string }>;
  candidates: Record<string, MaterialChoice[]>;
  designs: Record<string, ComponentDesign>;
  thermal: Record<string, { tempMarginC: number; expansionMm: number; restrainedStressMPa: number; strengthFactor: number }>;
  fatigue: Record<string, { applicable: boolean; goodmanSf?: number; enduranceMPa?: number; alternatingMPa?: number; meanMPa?: number; assumptions: string[] }>;
  tolerance: Record<string, { standard: string; worstCaseSf: number; notes: string[] }>;
  findings: Finding[];
  rulesApplied: string[];
  references: { standard: string; scope: string; note: string }[];
  channels: ChannelDef[];
  report: { text: string; source: 'llm' | 'rules'; model?: string };
}

interface NodeOutcome { status?: NodeStatus; summary: string; outputs?: unknown }

export interface SwarmNodeDef {
  id: string;
  name: string;
  role: string;
  dependsOn: string[];
  usesLlm?: boolean;
  run: (s: SwarmState) => Promise<NodeOutcome> | NodeOutcome;
}

const comps = (s: SwarmState): ComponentSpec[] => s.plan?.components ?? [];
const target = (s: SwarmState): number => s.plan!.requirements.targetSafetyFactor;
const dynFor = (s: SwarmState, c: ComponentSpec): number => (c.cyclic ? s.plan!.requirements.dynamicFactor : 1);

/* ── Sizing ── */

const SIZES = [10, 12, 16, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 140, 160, 180, 200, 250, 300, 350, 400, 500, 600];
const SHAFT_D = [6, 8, 10, 12, 15, 17, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 120, 140, 160, 200, 250];
const WALL_T = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];

function shapeFor(c: ComponentSpec, m: Material): SectionShape {
  if (c.geometry === 'shaft') return 'round';
  if (c.geometry === 'pressure_vessel') return 'tube';
  if (c.geometry === 'plate') return 'rect';
  const metal = m.family !== 'polymer' && m.family !== 'composite';
  if (!metal) return m.family === 'composite' ? 'tube' : 'rect';
  if (m.family === 'cast_iron') return 'rect';
  if (c.geometry === 'beam' && c.lengthMm >= 1500) return 'ibeam';
  return 'rhs';
}

function seriesFor(shape: SectionShape, c: ComponentSpec): number[] {
  if (c.geometry === 'pressure_vessel' || c.geometry === 'plate') return WALL_T;
  return shape === 'round' ? SHAFT_D : SIZES;
}

const r1 = (x: number) => Math.round(x * 2) / 2;

function sectionFor(shape: SectionShape, size: number, c: ComponentSpec): Section {
  if (c.geometry === 'pressure_vessel') return { shape: 'tube', D: c.diameterMm ?? 500, t: size };
  if (c.geometry === 'plate') return { shape: 'rect', b: c.widthMm ?? 500, h: size };
  switch (shape) {
    case 'round': return { shape, d: size };
    case 'tube': return { shape, D: size, t: Math.max(1, r1(size / 12)) };
    case 'rect': return { shape, b: r1(size / 2), h: size };
    case 'rhs': return { shape, b: size, h: size, t: Math.max(1.5, r1(size / 14)) };
    case 'ibeam': return { shape, b: r1(size / 2), h: size, tf: Math.max(3, r1(size / 16)), tw: Math.max(2.5, r1(size / 25)) };
  }
}

export function describeSection(s: Section): string {
  return sectionProps(s).label;
}

function sizeComponent(c: ComponentSpec, m: Material, sfTarget: number, dyn: number): ComponentDesign {
  const shape = shapeFor(c, m);
  const series = seriesFor(shape, c);
  let iterations = 0;
  let last: { section: Section; res: ReturnType<typeof analyze> } | undefined;
  for (const size of series) {
    iterations++;
    const section = sectionFor(shape, size, c);
    if (c.geometry === 'pressure_vessel' && size * 2 >= (c.diameterMm ?? 500)) break;
    const res = analyze(c, m, section, { loadScale: dyn });
    last = { section, res };
    if (res.sf >= sfTarget && res.deflectionMm <= res.deflectionLimitMm) break;
  }
  if (!last) throw new Error(`no section could be built for ${c.name}`);
  const ok = last.res.sf >= sfTarget && last.res.deflectionMm <= last.res.deflectionLimitMm;
  return {
    componentId: c.id, materialId: m.id, materialName: m.name, section: last.section, dims: describeSection(last.section),
    sizingOk: ok, sizingIterations: iterations, massKg: round(massKg(c, m, last.section), 3), results: last.res,
  };
}

/* ── Rules ── */

const iso2768m = (mm: number) => (mm <= 6 ? 0.1 : mm <= 30 ? 0.2 : mm <= 120 ? 0.3 : mm <= 400 ? 0.5 : mm <= 1000 ? 0.8 : 1.2);

function worstCaseSection(s: Section): Section {
  const d = (v?: number) => (v === undefined ? undefined : Math.max(0.1, v - iso2768m(v)));
  const wall = (v?: number) => (v === undefined ? undefined : v * 0.9);
  return { ...s, b: d(s.b), h: s.shape === 'rect' && s.b && s.b > (s.h ?? 0) * 4 ? wall(s.h) : d(s.h), d: d(s.d), D: d(s.D), t: wall(s.t), tf: wall(s.tf), tw: wall(s.tw) };
}

function processFor(c: ComponentSpec, m: Material, s: Section): { process: string; factor: number } {
  if (m.family === 'composite') return { process: 'prepreg layup + autoclave or out-of-autoclave cure, bonded metallic inserts at fixings', factor: 3 };
  if (m.family === 'polymer') return { process: 'machined from stock (prototype) or injection moulded with ribs (volume > ~1000)', factor: 1.8 };
  if (m.family === 'cast_iron') return { process: 'sand casting + machining of mounting faces', factor: 1.4 };
  if (m.family === 'titanium') return { process: 'CNC machining from bar/plate, or L-PBF additive for complex topology', factor: 2.5 };
  if (c.geometry === 'pressure_vessel') return { process: 'rolled and welded plate (qualified welding procedure, NDT of seams), formed heads', factor: 2.2 };
  if (c.geometry === 'shaft') return { process: 'CNC turning from bar, ground bearing seats, keyway milling', factor: 1.8 };
  if (c.geometry === 'plate') return { process: 'laser / waterjet cut plate, drilled fixings', factor: 1.2 };
  if (s.shape === 'ibeam') return { process: 'standard rolled section cut to length, drilled/welded end plates', factor: 1.1 };
  if (m.family === 'aluminium') return { process: 'extruded profile cut to length + CNC machined fixings', factor: 1.3 };
  return { process: 'cold-formed hollow section cut to length, welded base plate, sheet-metal gussets as needed', factor: 1.2 };
}

/* ── Nodes ── */

export const NODES: SwarmNodeDef[] = [
  {
    id: 'INTENT', name: 'Intent parser', role: 'Turns the plain-language goal into a structured plan (LLM with rules fallback)', dependsOn: [], usesLlm: true,
    run: async (s) => {
      const p = await makePlan(s.goal, s.opts);
      s.plan = p.plan; s.planSource = p.source; s.planModel = p.model; s.planNotes = p.notes; s.llmAvailable = p.llmAvailable;
      return { summary: `${p.plan.components.length} component(s) from ${p.source}${p.model ? ` (${p.model})` : ''}`, outputs: { source: p.source, model: p.model, notes: p.notes } };
    },
  },
  {
    id: 'ARCHITECT', name: 'System architect', role: 'Validates the plan and assigns each component an analysis route', dependsOn: ['INTENT'],
    run: (s) => {
      s.architecture = comps(s).map((c) => ({
        componentId: c.id,
        role: `${c.name}: ${c.geometry.replace('_', ' ')}, ${c.support.replace('_', ' ')}, L = ${c.lengthMm} mm`,
        analysis: c.geometry === 'pressure_vessel' ? 'closed-form thin-wall shell' : c.geometry === 'shaft' ? 'FE bending + closed-form torsion' : c.geometry === 'plate' ? 'FE beam-strip approximation' : 'FE beam',
      }));
      const warn = comps(s).some((c) => c.geometry === 'frame' || c.geometry === 'plate');
      return { status: warn ? 'warn' : 'done', summary: s.architecture.map((a) => a.role).join('; '), outputs: { architecture: s.architecture, assumptions: s.plan!.assumptions } };
    },
  },
  {
    id: 'LOADS', name: 'Load cases', role: 'Builds service and factored design load cases', dependsOn: ['ARCHITECT'],
    run: (s) => {
      for (const c of comps(s)) {
        const p = primaryLoad(c), dyn = dynFor(s, c);
        s.designLoads[c.id] = { dynamicFactor: dyn, serviceLoad: round(p.value, 3), designLoad: round(p.value * dyn, 3), unit: p.unit };
      }
      return { summary: Object.entries(s.designLoads).map(([id, l]) => `${id}: ${l.serviceLoad} ${l.unit} × ${l.dynamicFactor} = ${l.designLoad} ${l.unit}`).join('; '), outputs: { designLoads: s.designLoads, selfWeight: 'included as UDL in FE analyses' } };
    },
  },
  {
    id: 'MORTEX', name: 'MORTEX materials prototyping', role: 'Ranks materials from the property library against the requirements', dependsOn: ['LOADS'],
    run: (s) => {
      const out: Record<string, unknown> = {};
      const notes: string[] = [];
      for (const c of comps(s)) {
        const sel = selectMaterials({
          minSafetyFactor: target(s), operatingTempC: c.operatingTempC, tempMarginC: s.plan!.requirements.tempMarginC,
          priority: s.plan!.requirements.priority, corrosive: c.corrosive, cyclic: c.cyclic, bending: c.geometry !== 'pressure_vessel', pressure: c.geometry === 'pressure_vessel', hint: c.materialHint,
        });
        if (!sel.ranked.length) throw new Error(`no material in the library survives ${c.operatingTempC} °C with a ${s.plan!.requirements.tempMarginC} °C margin`);
        s.candidates[c.id] = sel.ranked;
        const fams = hintFamilies(c.materialHint);
        const top = getMaterial(sel.ranked[0].id)!;
        if (fams.length && !fams.includes(top.family)) {
          const why = sel.excluded.filter((x) => fams.includes(getMaterial(x.id)!.family)).map((x) => `${x.id}: ${x.reason}`);
          notes.push(`${c.id}: requested "${c.materialHint}" not used${why.length ? ` (${why.join('; ')})` : ''}`);
        }
        out[c.id] = { top: sel.ranked.slice(0, 4), excluded: sel.excluded };
      }
      return { status: notes.length ? 'warn' : 'done', summary: comps(s).map((c) => `${c.id}: ${s.candidates[c.id][0].name}`).concat(notes).join('; '), outputs: { ...out, notes } };
    },
  },
  {
    id: 'GEOMETRY', name: 'Geometry sizing', role: 'Iterates section size with the FE solver until SF ≥ target and deflection is within limit', dependsOn: ['MORTEX', 'LOADS'],
    run: (s) => {
      const log: Record<string, string[]> = {};
      let failed = 0;
      for (const c of comps(s)) {
        log[c.id] = [];
        let chosen: ComponentDesign | undefined;
        for (const cand of s.candidates[c.id].slice(0, 4)) {
          const d = sizeComponent(c, getMaterial(cand.id)!, target(s), dynFor(s, c));
          log[c.id].push(`${cand.id}: ${d.dims} → SF ${d.results.sf.toFixed(2)}, δ ${d.results.deflectionMm.toFixed(2)} mm in ${d.sizingIterations} iterations${d.sizingOk ? '' : ' (not satisfied)'}`);
          chosen ??= d;
          if (d.sizingOk) { chosen = d; break; }
        }
        if (!chosen!.sizingOk) failed++;
        s.designs[c.id] = chosen!;
      }
      return {
        status: failed ? 'fail' : 'done',
        summary: comps(s).map((c) => `${c.id}: ${s.designs[c.id].materialId} ${s.designs[c.id].dims}${s.designs[c.id].sizingOk ? '' : ' (FAILED to reach target)'}`).join('; '),
        outputs: { log },
      };
    },
  },
  {
    id: 'FEA', name: 'Structural solver', role: '1D Euler–Bernoulli FE + closed-form checks at factored design load', dependsOn: ['GEOMETRY'],
    run: (s) => {
      const out: Record<string, unknown> = {};
      let worst = Infinity;
      for (const c of comps(s)) {
        const d = s.designs[c.id];
        d.results = analyze(c, getMaterial(d.materialId)!, d.section, { loadScale: dynFor(s, c), elements: 40 });
        worst = Math.min(worst, d.results.sf);
        out[c.id] = { method: d.results.method, approximation: d.results.approximation, maxStressMPa: round(d.results.maxStressMPa, 2), allowableMPa: round(d.results.allowableMPa, 1), sf: round(d.results.sf, 3), deflectionMm: round(d.results.deflectionMm, 3), limitMm: round(d.results.deflectionLimitMm, 2) };
      }
      return { status: worst < 1 ? 'fail' : worst < target(s) ? 'warn' : 'done', summary: `min SF ${worst.toFixed(2)} (target ${target(s)})`, outputs: out };
    },
  },
  {
    id: 'THERMAL', name: 'Thermal', role: 'Service-temperature margin, expansion and restrained thermal stress', dependsOn: ['GEOMETRY'],
    run: (s) => {
      let minMargin = Infinity;
      for (const c of comps(s)) {
        const m = getMaterial(s.designs[c.id].materialId)!;
        const dT = c.operatingTempC - ASSEMBLY_TEMP_C;
        const margin = m.maxServiceC - c.operatingTempC;
        minMargin = Math.min(minMargin, margin);
        s.thermal[c.id] = {
          tempMarginC: margin,
          expansionMm: round(m.expansion1e6K * 1e-6 * dT * c.lengthMm, 4),
          restrainedStressMPa: round(thermalRestraint(c.support, c.geometry) * m.eGPa * 1e3 * m.expansion1e6K * 1e-6 * Math.abs(dT), 2),
          strengthFactor: round(yieldAt(m, c.operatingTempC) / m.yieldMPa, 3),
        };
      }
      return { status: minMargin < 0 ? 'fail' : minMargin < s.plan!.requirements.tempMarginC ? 'warn' : 'done', summary: `min service-temperature margin ${minMargin.toFixed(0)} °C`, outputs: s.thermal };
    },
  },
  {
    id: 'FATIGUE', name: 'Fatigue', role: 'Modified-Goodman check against an estimated endurance limit', dependsOn: ['FEA'],
    run: (s) => {
      let worst = Infinity;
      for (const c of comps(s)) {
        if (!c.cyclic) { s.fatigue[c.id] = { applicable: false, assumptions: ['static loading: fatigue not governing'] }; continue; }
        const d = s.designs[c.id], m = getMaterial(d.materialId)!;
        const service = analyze(c, m, d.section, { loadScale: 1 }).maxStressMPa;
        const ratio = m.family === 'aluminium' ? 0.4 : m.family === 'polymer' ? 0.3 : m.family === 'cast_iron' ? 0.4 : 0.5;
        const cap = m.family === 'aluminium' ? 130 : m.family === 'steel' || m.family === 'stainless' ? 700 : Infinity;
        const se = Math.min(ratio * m.ultimateMPa, cap) * 0.6;
        const amp = Math.max(0.1, dynFor(s, c) - 1) * service;
        const n = 1 / (amp / se + service / m.ultimateMPa);
        worst = Math.min(worst, n);
        s.fatigue[c.id] = {
          applicable: true, goodmanSf: round(n, 3), enduranceMPa: round(se, 1), alternatingMPa: round(amp, 2), meanMPa: round(service, 2),
          assumptions: [
            `Se' = ${ratio}·Su${Number.isFinite(cap) ? ` (capped ${cap} MPa)` : ''}${m.family === 'aluminium' ? ' at 5e8 cycles (no true endurance limit)' : ''}`,
            'combined Marin factor 0.6 (surface, size, 90% reliability)',
            `mean = service stress, alternating = (dynamic factor − 1) × service stress (min 10%)`,
            'no stress-concentration factor applied: detail welds/holes separately (e.g. EN 1993-1-9 detail categories)',
          ],
        };
      }
      return { status: worst < 1 ? 'fail' : worst < 1.5 ? 'warn' : 'done', summary: Number.isFinite(worst) ? `min Goodman SF ${worst.toFixed(2)}` : 'no cyclic components', outputs: s.fatigue };
    },
  },
  {
    id: 'TOLERANCE', name: 'Tolerancing', role: 'Assigns general tolerances and checks worst-case section strength', dependsOn: ['GEOMETRY'],
    run: (s) => {
      let worst = Infinity;
      for (const c of comps(s)) {
        const d = s.designs[c.id], m = getMaterial(d.materialId)!;
        const wc = analyze(c, m, worstCaseSection(d.section), { loadScale: dynFor(s, c) });
        worst = Math.min(worst, wc.sf);
        s.tolerance[c.id] = {
          standard: 'ISO 2768-m general tolerances; wall thickness −10% (hollow-section mill tolerance)',
          worstCaseSf: round(wc.sf, 3),
          notes: c.geometry === 'shaft' ? ['bearing seats k6/h6, Ra 0.8 µm'] : c.support === 'cantilever' ? ['mounting face flatness 0.1 mm', 'fixing holes ±0.2 mm position'] : ['support bearing faces flatness 0.2 mm'],
        };
      }
      return { status: worst < target(s) ? 'warn' : 'done', summary: `worst-case SF at minimum material ${worst.toFixed(2)}`, outputs: s.tolerance };
    },
  },
  {
    id: 'MANUFACTURING', name: 'Manufacturing', role: 'Suggests a production process for each component', dependsOn: ['GEOMETRY'],
    run: (s) => {
      for (const c of comps(s)) {
        const d = s.designs[c.id];
        d.process = processFor(c, getMaterial(d.materialId)!, d.section).process;
      }
      return { summary: comps(s).map((c) => `${c.id}: ${s.designs[c.id].process}`).join('; '), outputs: Object.fromEntries(comps(s).map((c) => [c.id, s.designs[c.id].process])) };
    },
  },
  {
    id: 'MASS', name: 'Mass budget', role: 'Computes component and total mass', dependsOn: ['GEOMETRY'],
    run: (s) => {
      const total = comps(s).reduce((t, c) => t + s.designs[c.id].massKg, 0);
      return { summary: `total ${total.toFixed(2)} kg`, outputs: { totalKg: round(total, 3), byComponent: Object.fromEntries(comps(s).map((c) => [c.id, s.designs[c.id].massKg])) } };
    },
  },
  {
    id: 'COST', name: 'Cost estimate', role: 'Relative cost index (material mass × cost index × process factor)', dependsOn: ['MASS', 'MANUFACTURING'],
    run: (s) => {
      let total = 0;
      for (const c of comps(s)) {
        const d = s.designs[c.id], m = getMaterial(d.materialId)!;
        d.costIndex = round(d.massKg * m.costIndex * processFor(c, m, d.section).factor, 3);
        total += d.costIndex;
      }
      return { summary: `relative cost ${total.toFixed(2)} units (1 unit ≈ 1 kg of S235 stock)`, outputs: { totalUnits: round(total, 3), note: 'relative index for comparing options, not a quote' } };
    },
  },
  {
    id: 'TELEMETRY', name: 'Instrumentation', role: 'Defines load, temperature and strain channels at critical locations', dependsOn: ['FEA'],
    run: (s) => {
      s.channels = [];
      for (const c of comps(s)) {
        const d = s.designs[c.id], m = getMaterial(d.materialId)!;
        const p = primaryLoad(c);
        const service = analyze(c, m, d.section, { loadScale: 1 }).maxStressMPa;
        const loadAt = c.geometry === 'pressure_vessel' ? 'pressure transducer on shell nozzle' : c.geometry === 'shaft' && p.kind === 'torque' ? 'inline torque transducer, drive end' : c.support === 'cantilever' ? 'load cell / pin at load application point (tip)' : 'load cell under applied load';
        const strainAt = c.geometry === 'pressure_vessel' ? 'hoop direction, mid-shell' : c.geometry === 'shaft' ? '45° rosette at mid-span' : c.support === 'cantilever' ? 'top fibre at fixed root (max moment)' : c.support === 'fixed_fixed' ? 'top fibre at a fixed end (max moment)' : 'bottom fibre at mid-span (max moment)';
        s.channels.push(
          { channel: `${c.id}.load`, componentId: c.id, kind: 'load', unit: p.unit, location: loadAt, nominal: round(p.value, 3) },
          { channel: `${c.id}.temp`, componentId: c.id, kind: 'temperature', unit: '°C', location: c.support === 'cantilever' ? 'thermocouple at mounting interface' : 'thermocouple at hottest surface', nominal: c.operatingTempC },
          { channel: `${c.id}.strain`, componentId: c.id, kind: 'strain', unit: 'µε', location: strainAt, nominal: round((service / m.eGPa) * 1000, 2) },
        );
      }
      return { summary: `${s.channels.length} channels on ${comps(s).length} component(s)`, outputs: s.channels };
    },
  },
  {
    id: 'SENTINEL', name: 'SENTINEL safety compliance', role: 'Applies the safety rule set and flags violations', dependsOn: ['FEA', 'THERMAL', 'FATIGUE', 'TOLERANCE'],
    run: (s) => {
      const T = target(s), margin = s.plan!.requirements.tempMarginC;
      s.rulesApplied = [
        `S1 static SF ≥ ${T} at factored design load (fail < 1.0)`,
        `S2 service-temperature margin ≥ ${margin} °C (fail if exceeded)`,
        'S3 deflection within serviceability limit (L/180 cantilever, L/250 span, L/200 plate strip)',
        'S4 Goodman fatigue SF ≥ 1.5 for cyclic loading',
        'S5 brittle materials require SF ≥ 3 in bending/tension',
        'S6 non-corrosion-resistant material in corrosive environment requires protection',
        `S7 worst-case tolerance SF ≥ ${T}`,
        'S8 polymers under sustained load above 50% of max service temperature: creep check required',
        'S9 pressure equipment: thin-wall validity (r/t ≥ 10) and regulatory classification',
        'S10 suspended loads over people: secondary retention advised',
      ];
      const f = s.findings = [] as Finding[];
      const add = (rule: string, componentId: string, severity: Finding['severity'], message: string) => f.push({ rule, componentId, severity, message });
      for (const c of comps(s)) {
        const d = s.designs[c.id], m = getMaterial(d.materialId)!, r = d.results;
        add('S1', c.id, r.sf < 1 ? 'fail' : r.sf < T ? 'warn' : 'info', `SF ${r.sf.toFixed(2)} (σ ${r.maxStressMPa.toFixed(1)} MPa vs derated yield ${r.allowableMPa.toFixed(0)} MPa)`);
        const th = s.thermal[c.id];
        add('S2', c.id, th.tempMarginC < 0 ? 'fail' : th.tempMarginC < margin ? 'warn' : 'info', `${c.operatingTempC} °C vs max service ${m.maxServiceC} °C (margin ${th.tempMarginC} °C)`);
        if (Number.isFinite(r.deflectionLimitMm)) add('S3', c.id, r.deflectionMm > r.deflectionLimitMm ? 'warn' : 'info', `deflection ${r.deflectionMm.toFixed(2)} mm vs limit ${r.deflectionLimitMm.toFixed(2)} mm`);
        const fa = s.fatigue[c.id];
        if (fa?.applicable) add('S4', c.id, fa.goodmanSf! < 1 ? 'fail' : fa.goodmanSf! < 1.5 ? 'warn' : 'info', `Goodman SF ${fa.goodmanSf!.toFixed(2)}`);
        if (m.brittle && c.geometry !== 'pressure_vessel' && r.sf < 3) add('S5', c.id, 'warn', `${m.name} is brittle; SF ${r.sf.toFixed(2)} < 3`);
        if (c.corrosive && !m.corrosionResistant) add('S6', c.id, 'warn', `${m.name} needs galvanising, paint or a stainless alternative`);
        const tol = s.tolerance[c.id];
        if (tol && tol.worstCaseSf < T) add('S7', c.id, 'warn', `worst-case tolerance SF ${tol.worstCaseSf.toFixed(2)} < ${T}`);
        if (m.family === 'polymer' && c.operatingTempC > 0.5 * m.maxServiceC) add('S8', c.id, 'warn', `sustained load at ${c.operatingTempC} °C on ${m.name}: obtain creep modulus data (ISO 899-1)`);
        if (c.geometry === 'pressure_vessel') {
          add('S9', c.id, r.approximation?.includes('< 10') ? 'warn' : 'info', `${r.approximation ?? ''}; classify under applicable pressure-equipment rules before use`);
        }
        if (c.geometry === 'bracket' || (c.support === 'cantilever' && c.loads.pointN > 100)) add('S10', c.id, 'info', 'wall anchors must be rated for the root moment and shear; add a secondary safety retention for suspended equipment');
      }
      const fails = f.filter((x) => x.severity === 'fail').length, warns = f.filter((x) => x.severity === 'warn').length;
      return { status: fails ? 'fail' : warns ? 'warn' : 'done', summary: `${fails} violation(s), ${warns} warning(s) across ${s.rulesApplied.length} rules`, outputs: { compliant: !fails, findings: f, rulesApplied: s.rulesApplied } };
    },
  },
  {
    id: 'COMPLIANCE-DOCS', name: 'Compliance references', role: 'Lists standards to consult (does not certify)', dependsOn: ['SENTINEL'],
    run: (s) => {
      const refs = s.references = [] as SwarmState['references'];
      const add = (standard: string, scope: string) => { if (!refs.some((r) => r.standard === standard)) refs.push({ standard, scope, note: `Consult ${standard}; this tool does not certify compliance.` }); };
      add('ISO 12100', 'machinery safety: general principles, risk assessment and risk reduction');
      add('ISO 2768-1/-2', 'general dimensional and geometric tolerances');
      for (const c of comps(s)) {
        const m = getMaterial(s.designs[c.id].materialId)!;
        if (m.family === 'steel') add('Eurocode 3 (EN 1993-1-1) / AISC 360', 'design of steel members');
        if (m.family === 'stainless') add('EN 1993-1-4', 'design of stainless steel members');
        if (m.family === 'aluminium') add('Eurocode 9 (EN 1999-1-1) / Aluminum Design Manual', 'design of aluminium members');
        if (c.cyclic && (m.family === 'steel' || m.family === 'stainless')) add('EN 1993-1-9', 'fatigue detail categories for steel');
        if (c.geometry === 'shaft') add('DIN 743', 'load capacity of shafts and axles');
        if (c.geometry === 'pressure_vessel') { add('Pressure Equipment Directive 2014/68/EU', 'EU pressure equipment classification'); add('ASME BPVC Section VIII Div. 1', 'pressure vessel design rules'); }
        if (m.family === 'polymer') add('ISO 899-1', 'tensile creep of plastics');
        if (m.family === 'composite') add('ASTM D3039 / CMH-17', 'composite tensile properties and design allowables');
        if (m.family === 'cast_iron') add('EN 1563 / ASTM A536', 'spheroidal graphite cast iron grades');
        if (c.support === 'cantilever') add('EAD 330232 / anchor manufacturer data', 'mechanical fasteners for use in concrete (wall anchors)');
        if (c.corrosive) add('ISO 9223 / ISO 12944', 'corrosivity categories and protective paint systems');
      }
      return { summary: `${refs.length} references to consult`, outputs: refs };
    },
  },
  {
    id: 'REPORT', name: 'Report', role: 'Assembles the engineering summary (optional LLM narrative)', usesLlm: true,
    dependsOn: ['INTENT', 'ARCHITECT', 'LOADS', 'MORTEX', 'GEOMETRY', 'FEA', 'THERMAL', 'FATIGUE', 'TOLERANCE', 'MANUFACTURING', 'COST', 'MASS', 'SENTINEL', 'COMPLIANCE-DOCS', 'TELEMETRY'],
    run: async (s) => {
      const lines = [`Goal: ${s.goal}`, `Plan (${s.planSource}${s.planModel ? `, ${s.planModel}` : ''}): ${s.plan!.summary}`];
      for (const c of comps(s)) {
        const d = s.designs[c.id];
        lines.push(`${c.name}: ${d.materialName}, ${d.dims}, SF ${d.results.sf.toFixed(2)} at design load, σmax ${d.results.maxStressMPa.toFixed(1)} MPa, δ ${d.results.deflectionMm.toFixed(2)} mm, ${d.massKg.toFixed(2)} kg. Process: ${d.process ?? 'n/a'}.`);
      }
      const fails = s.findings.filter((x) => x.severity === 'fail'), warns = s.findings.filter((x) => x.severity === 'warn');
      lines.push(fails.length ? `SENTINEL: NOT compliant, ${fails.length} violation(s): ${fails.map((x) => `${x.rule} ${x.message}`).join('; ')}` : `SENTINEL: no violations, ${warns.length} warning(s)${warns.length ? `: ${warns.map((x) => `${x.rule} ${x.message}`).join('; ')}` : ''}.`);
      lines.push(`Instrument ${s.channels.length} channels for continuous verification. Standards to consult: ${s.references.map((r) => r.standard).join(', ')}.`);
      const text = lines.join('\n');
      s.report = { text, source: 'rules' };
      if (s.llmAvailable && s.opts.llm !== false) {
        try {
          const r = await withTimeout(ask('AXIOM', `Write a concise engineering design summary (max 180 words) for a reviewer, from these verified results. Do not invent numbers.\n\n${text}`, { maxTokens: 600, model: s.opts.model }), 60_000);
          if (r.text.trim()) s.report = { text: `${r.text.trim()}\n\n---\n${text}`, source: 'llm', model: r.spec };
        } catch { /* deterministic report stands */ }
      }
      return { summary: `report assembled (${s.report.source})`, outputs: s.report };
    },
  },
];

export function nodeDefinitions() {
  return NODES.map(({ id, name, role, dependsOn, usesLlm }) => ({ id, name, role, dependsOn, usesLlm: !!usesLlm }));
}

export function levels(nodes: SwarmNodeDef[] = NODES): string[][] {
  const done = new Set<string>();
  const out: string[][] = [];
  while (done.size < nodes.length) {
    const lvl = nodes.filter((n) => !done.has(n.id) && n.dependsOn.every((d) => done.has(d))).map((n) => n.id);
    if (!lvl.length) throw new Error('swarm dependency cycle');
    lvl.forEach((id) => done.add(id));
    out.push(lvl);
  }
  return out;
}

export function newState(goal: string, opts: ProjectOptions): SwarmState {
  return {
    goal, opts, planSource: 'rules', planNotes: [], llmAvailable: false, architecture: [], designLoads: {}, candidates: {}, designs: {},
    thermal: {}, fatigue: {}, tolerance: {}, findings: [], rulesApplied: [], references: [], channels: [], report: { text: '', source: 'rules' },
  };
}

export async function runSwarm(goal: string, opts: ProjectOptions = {}): Promise<{ state: SwarmState; nodes: SwarmNodeRun[]; levels: string[][]; ms: number }> {
  const t0 = Date.now();
  const state = newState(goal, opts);
  const lv = levels();
  const runs = new Map<string, SwarmNodeRun & { blocking?: boolean }>();
  for (const level of lv) {
    await Promise.all(level.map(async (id) => {
      const def = NODES.find((n) => n.id === id)!;
      const startedAt = new Date().toISOString();
      const t = Date.now();
      const blocked = def.dependsOn.filter((d) => runs.get(d)?.blocking || runs.get(d)?.status === 'skipped');
      if (blocked.length) {
        runs.set(id, { id, name: def.name, status: 'skipped', startedAt, ms: 0, summary: `skipped: ${blocked.join(', ')} did not complete`, outputs: null });
        return;
      }
      try {
        const o = await traced(`engineering.${id}`, 'tool', { goal, node: id }, async () => def.run(state), { outputs: (x) => ({ status: x.status ?? 'done', summary: x.summary }) });
        runs.set(id, { id, name: def.name, status: o.status ?? 'done', startedAt, ms: Date.now() - t, summary: o.summary, outputs: o.outputs ?? null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runs.set(id, { id, name: def.name, status: 'fail', startedAt, ms: Date.now() - t, summary: msg, outputs: { error: msg }, blocking: true });
      }
    }));
  }
  const nodes = NODES.map((n) => { const { blocking: _b, ...r } = runs.get(n.id)!; return r; });
  return { state, nodes, levels: lv, ms: Date.now() - t0 };
}

