import { sectionProps, solveBeam, thermalStressPa, torsionShearPa, vesselStressPa } from './fea.js';
import { yieldAt, type Material } from './materials.js';
import type { AnalysisResult, ComponentSpec, Section, SupportType } from './types.js';

export const ASSEMBLY_TEMP_C = 20;
const G = 9.81;

export function deflectionLimitMm(c: ComponentSpec): number {
  if (c.geometry === 'pressure_vessel') return Infinity;
  if (c.geometry === 'shaft') return c.lengthMm / 1000;
  return c.lengthMm / (c.support === 'cantilever' ? 180 : c.geometry === 'plate' ? 200 : 250);
}

// Share of free thermal strain that is restrained: cantilever and pinned/roller spans are free to expand.
export function thermalRestraint(support: SupportType, geometry: ComponentSpec['geometry']): number {
  if (geometry === 'pressure_vessel' || geometry === 'shaft') return 0;
  return support === 'fixed_fixed' ? 1 : 0;
}

export function primaryLoad(c: ComponentSpec): { value: number; unit: string; kind: string } {
  if (c.geometry === 'pressure_vessel') return { value: c.loads.pressureMPa, unit: 'MPa', kind: 'pressure' };
  if (c.geometry === 'shaft' && c.loads.torqueNm > 0) return { value: c.loads.torqueNm, unit: 'N·m', kind: 'torque' };
  return { value: c.loads.pointN + c.loads.udlNPerM * (c.lengthMm / 1000), unit: 'N', kind: 'force' };
}

export function massKg(c: ComponentSpec, m: Material, s: Section): number {
  return sectionProps(s).areaM2 * (c.lengthMm / 1000) * m.densityKgM3;
}

export function analyze(c: ComponentSpec, m: Material, s: Section, opts: { loadScale?: number; tempC?: number; elements?: number } = {}): AnalysisResult {
  const k = opts.loadScale ?? 1;
  const tempC = opts.tempC ?? c.operatingTempC;
  const E = m.eGPa * 1e9;
  const props = sectionProps(s);
  const allowableMPa = yieldAt(m, tempC);
  const dT = tempC - ASSEMBLY_TEMP_C;
  const restraint = thermalRestraint(c.support, c.geometry);
  const thermalStressMPa = Math.abs(thermalStressPa(E, m.expansion1e6K * 1e-6, dT)) / 1e6;
  const thermal = restraint * thermalStressMPa;
  const base = { loadScale: k, tempC, thermalStressMPa, thermalIncluded: restraint > 0, allowableMPa, deflectionLimitMm: deflectionLimitMm(c) };

  if (c.geometry === 'pressure_vessel') {
    const D = (s.D ?? c.diameterMm ?? 500) / 1000, t = (s.t ?? 5) / 1000;
    const v = vesselStressPa(c.loads.pressureMPa * 1e6 * k, D, t);
    const hoop = v.hoop / 1e6, axial = v.axial / 1e6;
    const vm = Math.sqrt(hoop ** 2 - hoop * axial + axial ** 2);
    const r = (D - t) / 2;
    return {
      ...base,
      method: 'closed-form thin-wall cylinder: σh = p·r/t, σa = p·r/(2t), von Mises',
      approximation: v.rOverT < 10 ? `r/t = ${v.rOverT.toFixed(1)} < 10: thin-wall theory is unconservative, use Lamé thick-wall` : 'shell only; heads, nozzles and welds not analysed',
      bendingStressMPa: 0, shearStressMPa: 0, hoopStressMPa: hoop,
      maxStressMPa: vm, sf: allowableMPa / Math.max(vm, 1e-9),
      deflectionMm: ((r * (hoop * 1e6) * (1 - 0.3 / 2)) / E) * 1000,
    };
  }

  const strip = c.geometry === 'plate';
  const udl = c.loads.udlNPerM * k + (strip ? c.loads.pressureMPa * 1e6 * k * ((c.widthMm ?? 500) / 1000) : 0) + props.areaM2 * m.densityKgM3 * G;
  const beam = solveBeam({
    lengthM: c.lengthMm / 1000, ePa: E, iM4: props.iM4, cM: props.cM, support: c.support, elements: opts.elements ?? 20,
    pointLoads: c.loads.pointN > 0 ? [{ xM: (c.lengthMm / 1000) * c.loads.pointAtFrac, N: c.loads.pointN * k }] : [], udlNPerM: udl,
  });
  const sigma = beam.maxStressPa / 1e6;
  const tau = c.geometry === 'shaft' ? torsionShearPa(c.loads.torqueNm * k, props) / 1e6 : 0;
  const vm = Math.sqrt((sigma + thermal) ** 2 + 3 * tau ** 2);
  const step = Math.max(1, Math.floor(beam.xM.length / 21));
  const diagram = beam.xM.filter((_, i) => i % step === 0 || i === beam.xM.length - 1).map((x) => {
    const i = beam.xM.indexOf(x);
    return { xMm: round(x * 1000, 1), momentNm: round(beam.momentNm[i], 2), deflectionMm: round(beam.deflectionM[i] * 1000, 4) };
  });
  const method = c.geometry === 'shaft'
    ? '1D Euler–Bernoulli FE (bending) + τ = T·r/J, von Mises √(σ²+3τ²)'
    : '1D Euler–Bernoulli FE, σ = M·c/I' + (restraint ? ' + restrained thermal σ = E·α·ΔT' : '');
  const approximation = strip
    ? 'plate approximated as a one-way beam strip (conservative for edge-supported plates)'
    : c.geometry === 'frame' ? 'frame member idealised as a fixed-fixed beam with rigid joints' : undefined;
  return {
    ...base, method, approximation,
    bendingStressMPa: sigma, shearStressMPa: tau, hoopStressMPa: 0,
    maxStressMPa: vm, sf: allowableMPa / Math.max(vm, 1e-9),
    deflectionMm: beam.maxDeflectionM * 1000,
    diagram, reactions: beam.reactions.map((r) => ({ dof: r.dof, value: round(r.value, 2) })),
  };
}

export function round(x: number, d = 3): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
