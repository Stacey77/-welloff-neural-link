export type MaterialFamily = 'steel' | 'stainless' | 'aluminium' | 'titanium' | 'cast_iron' | 'polymer' | 'composite' | 'copper';

export interface Material {
  id: string;
  name: string;
  family: MaterialFamily;
  densityKgM3: number;
  eGPa: number;
  yieldMPa: number;
  ultimateMPa: number;
  maxServiceC: number;
  expansion1e6K: number;
  conductivityWmK: number;
  costIndex: number;
  corrosionResistant: boolean;
  brittle: boolean;
  notes: string;
}

// Typical room-temperature handbook / datasheet values (EN 10025, ASM, MatWeb-class sources); not design allowables.
export const MATERIALS: Material[] = [
  { id: 's235', name: 'Structural steel S235JR (EN 10025-2)', family: 'steel', densityKgM3: 7850, eGPa: 210, yieldMPa: 235, ultimateMPa: 360, maxServiceC: 350, expansion1e6K: 12, conductivityWmK: 50, costIndex: 1.0, corrosionResistant: false, brittle: false, notes: 'Yield for t ≤ 16 mm. Needs paint or galvanising outdoors.' },
  { id: 's355', name: 'Structural steel S355JR (EN 10025-2)', family: 'steel', densityKgM3: 7850, eGPa: 210, yieldMPa: 355, ultimateMPa: 470, maxServiceC: 350, expansion1e6K: 12, conductivityWmK: 50, costIndex: 1.15, corrosionResistant: false, brittle: false, notes: 'Yield for t ≤ 16 mm. Weldable; needs corrosion protection.' },
  { id: 'ss304', name: 'Stainless steel 304 (annealed)', family: 'stainless', densityKgM3: 8000, eGPa: 193, yieldMPa: 215, ultimateMPa: 505, maxServiceC: 870, expansion1e6K: 17.3, conductivityWmK: 16.2, costIndex: 4.0, corrosionResistant: true, brittle: false, notes: 'General corrosion resistance; prone to chloride pitting.' },
  { id: 'ss316', name: 'Stainless steel 316 (annealed)', family: 'stainless', densityKgM3: 8000, eGPa: 193, yieldMPa: 205, ultimateMPa: 515, maxServiceC: 870, expansion1e6K: 16, conductivityWmK: 16.3, costIndex: 5.0, corrosionResistant: true, brittle: false, notes: 'Mo-bearing; preferred for marine / washdown.' },
  { id: 'al6061', name: 'Aluminium 6061-T6', family: 'aluminium', densityKgM3: 2700, eGPa: 68.9, yieldMPa: 276, ultimateMPa: 310, maxServiceC: 150, expansion1e6K: 23.6, conductivityWmK: 167, costIndex: 3.0, corrosionResistant: true, brittle: false, notes: 'Weld HAZ loses ~40% strength; no true fatigue limit.' },
  { id: 'al7075', name: 'Aluminium 7075-T6', family: 'aluminium', densityKgM3: 2810, eGPa: 71.7, yieldMPa: 503, ultimateMPa: 572, maxServiceC: 120, expansion1e6K: 23.4, conductivityWmK: 130, costIndex: 6.0, corrosionResistant: false, brittle: false, notes: 'High strength; poor weldability, susceptible to SCC.' },
  { id: 'ti64', name: 'Titanium Ti-6Al-4V (annealed)', family: 'titanium', densityKgM3: 4430, eGPa: 113.8, yieldMPa: 880, ultimateMPa: 950, maxServiceC: 400, expansion1e6K: 8.6, conductivityWmK: 6.7, costIndex: 30, corrosionResistant: true, brittle: false, notes: 'Excellent strength-to-weight; expensive to machine.' },
  { id: 'di65', name: 'Ductile cast iron ASTM A536 65-45-12', family: 'cast_iron', densityKgM3: 7100, eGPa: 169, yieldMPa: 310, ultimateMPa: 448, maxServiceC: 350, expansion1e6K: 11, conductivityWmK: 36, costIndex: 0.9, corrosionResistant: false, brittle: false, notes: 'Castable complex shapes; good damping.' },
  { id: 'gi30', name: 'Grey cast iron ASTM A48 Class 30', family: 'cast_iron', densityKgM3: 7200, eGPa: 100, yieldMPa: 214, ultimateMPa: 214, maxServiceC: 350, expansion1e6K: 11, conductivityWmK: 46, costIndex: 0.7, corrosionResistant: false, brittle: true, notes: 'Brittle: no yield, strength taken as UTS. Strong in compression only.' },
  { id: 'pa66', name: 'Nylon PA66 (unfilled, dry as moulded)', family: 'polymer', densityKgM3: 1140, eGPa: 2.9, yieldMPa: 80, ultimateMPa: 85, maxServiceC: 100, expansion1e6K: 80, conductivityWmK: 0.25, costIndex: 2.5, corrosionResistant: true, brittle: false, notes: 'Moisture uptake cuts strength ~30%; creeps under sustained load.' },
  { id: 'peek', name: 'PEEK (unfilled)', family: 'polymer', densityKgM3: 1300, eGPa: 3.6, yieldMPa: 100, ultimateMPa: 100, maxServiceC: 250, expansion1e6K: 47, conductivityWmK: 0.25, costIndex: 40, corrosionResistant: true, brittle: false, notes: 'High-temperature engineering polymer; chemically resistant.' },
  { id: 'cfrp', name: 'CFRP quasi-isotropic laminate (T300/epoxy typical)', family: 'composite', densityKgM3: 1550, eGPa: 50, yieldMPa: 450, ultimateMPa: 600, maxServiceC: 120, expansion1e6K: 2, conductivityWmK: 5, costIndex: 25, corrosionResistant: true, brittle: true, notes: 'No yield: "yield" is a design allowable proxy. Limited by matrix Tg; galvanic risk with aluminium.' },
  { id: 'cu110', name: 'Copper C110 (H02 half hard)', family: 'copper', densityKgM3: 8890, eGPa: 115, yieldMPa: 250, ultimateMPa: 290, maxServiceC: 200, expansion1e6K: 17, conductivityWmK: 388, costIndex: 8, corrosionResistant: true, brittle: false, notes: 'Chosen for conductivity, not structure; softens above ~200 °C.' },
];

export function getMaterial(id: string): Material | undefined {
  return MATERIALS.find((m) => m.id === id);
}

// Rule-of-thumb strength knock-down with temperature (assumption, not handbook data).
export function strengthFactorAt(m: Material, tempC: number): number {
  if (m.family === 'polymer' || m.family === 'composite') {
    const k = 1 - 0.5 * Math.max(0, tempC - 23) / Math.max(1, m.maxServiceC - 23);
    return Math.max(0.3, Math.min(1, k));
  }
  const onset = m.family === 'aluminium' ? 80 : 150;
  const k = 1 - 0.3 * Math.max(0, tempC - onset) / Math.max(1, m.maxServiceC - onset);
  return Math.max(0.5, Math.min(1, k));
}

export function yieldAt(m: Material, tempC: number): number {
  return m.yieldMPa * strengthFactorAt(m, tempC);
}

export interface MaterialRequirements {
  minSafetyFactor?: number;
  designStressMPa?: number;
  operatingTempC?: number;
  tempMarginC?: number;
  priority?: 'mass' | 'cost' | 'balanced';
  corrosive?: boolean;
  cyclic?: boolean;
  bending?: boolean;
  pressure?: boolean;
  hint?: string;
}

export interface MaterialChoice {
  id: string;
  name: string;
  score: number;
  reasons: string[];
}

const HINTS: [RegExp, MaterialFamily[]][] = [
  [/stainless|inox|30[46]|316/, ['stainless']],
  [/titanium|ti-?6al/, ['titanium']],
  [/alumin(i)?um|6061|7075/, ['aluminium']],
  [/cast iron|ductile iron|grey iron|gray iron/, ['cast_iron']],
  [/carbon fib(re|er)|cfrp|composite/, ['composite']],
  [/peek|nylon|pa66|plastic|polymer/, ['polymer']],
  [/copper/, ['copper']],
  [/steel/, ['steel', 'stainless']],
];

export function hintFamilies(hint?: string): MaterialFamily[] {
  if (!hint) return [];
  const h = hint.toLowerCase();
  for (const [re, fam] of HINTS) if (re.test(h)) return fam;
  return [];
}

// Ashby-style indices for a strength-limited beam in bending: mass ∝ ρ/σy^(2/3), stiffness ∝ ρ/E^(1/2).
export function selectMaterials(req: MaterialRequirements, pool: Material[] = MATERIALS): { ranked: MaterialChoice[]; excluded: { id: string; reason: string }[] } {
  const temp = req.operatingTempC ?? 20;
  const margin = req.tempMarginC ?? 15;
  const sf = req.minSafetyFactor ?? 2;
  const priority = req.priority ?? 'balanced';
  const families = hintFamilies(req.hint);
  const excluded: { id: string; reason: string }[] = [];
  const ok = pool.filter((m) => {
    if (m.maxServiceC < temp + margin) {
      excluded.push({ id: m.id, reason: `max service ${m.maxServiceC} °C leaves < ${margin} °C margin at ${temp} °C` });
      return false;
    }
    if (req.designStressMPa && yieldAt(m, temp) < sf * req.designStressMPa) {
      excluded.push({ id: m.id, reason: `derated yield ${yieldAt(m, temp).toFixed(0)} MPa < SF ${sf} × ${req.designStressMPa.toFixed(0)} MPa` });
      return false;
    }
    return true;
  });
  if (!ok.length) return { ranked: [], excluded };

  const idx = ok.map((m) => {
    const sy = yieldAt(m, temp);
    const mass = m.densityKgM3 / Math.pow(sy, 2 / 3);
    return { m, sy, mass, cost: mass * m.costIndex, stiff: m.densityKgM3 / Math.sqrt(m.eGPa) };
  });
  const best = { mass: Math.min(...idx.map((x) => x.mass)), cost: Math.min(...idx.map((x) => x.cost)), stiff: Math.min(...idx.map((x) => x.stiff)) };
  const w = priority === 'mass' ? { mass: 0.55, cost: 0.15, stiff: 0.3 } : priority === 'cost' ? { mass: 0.15, cost: 0.6, stiff: 0.25 } : { mass: 0.35, cost: 0.4, stiff: 0.25 };

  const ranked = idx.map(({ m, sy, mass, cost, stiff }) => {
    const reasons: string[] = [];
    const sMass = best.mass / mass, sCost = best.cost / cost, sStiff = best.stiff / stiff;
    let score = w.mass * sMass + w.cost * sCost + w.stiff * sStiff;
    reasons.push(`mass index ${(sMass * 100).toFixed(0)}%, cost index ${(sCost * 100).toFixed(0)}%, stiffness index ${(sStiff * 100).toFixed(0)}% of best`);
    reasons.push(`yield ${sy.toFixed(0)} MPa at ${temp} °C, service limit ${m.maxServiceC} °C (margin ${m.maxServiceC - temp} °C)`);
    score += 0.1 * Math.min(1, (m.maxServiceC - temp) / 200);
    if (req.corrosive && !m.corrosionResistant) { score *= 0.6; reasons.push('corrosive environment: needs coating or galvanising'); }
    if (req.corrosive && m.corrosionResistant) reasons.push('inherently corrosion resistant');
    if (m.brittle && (req.bending ?? true)) { score *= 0.5; reasons.push('brittle in tension/bending: penalised'); }
    if (req.cyclic && m.family === 'polymer') { score *= 0.8; reasons.push('polymer under cyclic load: creep and fatigue risk'); }
    if (req.cyclic && m.family === 'aluminium') reasons.push('aluminium has no true endurance limit');
    if (req.pressure && (m.family === 'cast_iron' || m.family === 'polymer' || m.family === 'composite')) { score *= 0.3; reasons.push('pressure equipment: cast, polymer and composite shells need special code provisions'); }
    if (families.length) {
      const i = families.indexOf(m.family);
      if (i === 0) { score += 1; reasons.push(`matches requested material "${req.hint}"`); }
      else if (i > 0) { score += 0.6; reasons.push(`related to requested material "${req.hint}"`); }
    }
    return { id: m.id, name: m.name, score: Math.round(score * 1000) / 1000, reasons };
  }).sort((a, b) => b.score - a.score);
  return { ranked, excluded };
}
