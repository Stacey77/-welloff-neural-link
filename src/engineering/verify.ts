import { analyze, primaryLoad, round } from './analysis.js';
import { getMaterial } from './materials.js';
import type { ComponentVerification, Plan, ComponentDesign, Status, VerificationReport } from './types.js';

export interface ComponentReading {
  load?: number;
  tempC?: number;
  strainMicro?: number;
}

export const VERIFY_RULES = [
  'FAIL if stress ≥ temperature-derated yield (SF < 1.0)',
  'FAIL if temperature exceeds the material maximum service temperature',
  'WARN if SF < target safety factor',
  'WARN if temperature margin to max service temperature < 15 °C',
  'WARN if deflection exceeds the serviceability limit (L/180 cantilever, L/250 span, L/200 plate strip)',
  'Measured stress = max(model stress scaled by measured/nominal load + restrained thermal, E·ε from strain gauge)',
  'Without readings, verification uses factored design loads (service load × dynamic factor)',
];

const worst = (a: Status, b: Status): Status => (a === 'fail' || b === 'fail' ? 'fail' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');

export function verifyDesign(design: { plan: Plan; designs: ComponentDesign[] }, readings?: Record<string, ComponentReading>): VerificationReport {
  const target = design.plan.requirements.targetSafetyFactor;
  const marginReq = design.plan.requirements.tempMarginC;
  const components: ComponentVerification[] = design.designs.map((d) => {
    const comp = design.plan.components.find((c) => c.id === d.componentId);
    const mat = getMaterial(d.materialId);
    if (!comp || !mat) {
      return { componentId: d.componentId, name: comp?.name ?? d.componentId, sf: 0, maxStressMPa: 0, deflectionMm: 0, tempC: 0, tempMarginC: 0, loadScale: 0, status: 'fail', messages: ['component or material missing from project'] };
    }
    const r = readings?.[comp.id];
    const nominal = primaryLoad(comp).value;
    const dyn = comp.cyclic ? design.plan.requirements.dynamicFactor : 1;
    const loadScale = r?.load !== undefined && nominal > 0 ? Math.max(0, r.load) / nominal : readings ? 1 : dyn;
    const tempC = r?.tempC ?? comp.operatingTempC;
    const a = analyze(comp, mat, d.section, { loadScale, tempC });
    const gauge = r?.strainMicro !== undefined ? Math.abs(r.strainMicro) * mat.eGPa / 1000 : undefined;
    const stress = Math.max(a.maxStressMPa, gauge ?? 0);
    const sf = a.allowableMPa / Math.max(stress, 1e-9);
    const tempMarginC = mat.maxServiceC - tempC;
    const messages: string[] = [];
    let status: Status = 'ok';
    if (sf < 1) { status = 'fail'; messages.push(`stress ${stress.toFixed(1)} MPa ≥ derated yield ${a.allowableMPa.toFixed(0)} MPa (SF ${sf.toFixed(2)})`); }
    else if (sf < target) { status = worst(status, 'warn'); messages.push(`SF ${sf.toFixed(2)} below target ${target}`); }
    if (tempMarginC < 0) { status = 'fail'; messages.push(`temperature ${tempC.toFixed(1)} °C exceeds max service ${mat.maxServiceC} °C`); }
    else if (tempMarginC < marginReq) { status = worst(status, 'warn'); messages.push(`temperature margin ${tempMarginC.toFixed(1)} °C < ${marginReq} °C`); }
    if (a.deflectionMm > a.deflectionLimitMm) { status = worst(status, 'warn'); messages.push(`deflection ${a.deflectionMm.toFixed(2)} mm > limit ${a.deflectionLimitMm.toFixed(2)} mm`); }
    if (gauge !== undefined && a.maxStressMPa > 0 && Math.abs(gauge - a.maxStressMPa) / a.maxStressMPa > 0.3) {
      messages.push(`strain-gauge stress ${gauge.toFixed(1)} MPa differs from model ${a.maxStressMPa.toFixed(1)} MPa by > 30%: check model or sensor`);
    }
    if (!messages.length) messages.push(`SF ${sf.toFixed(2)} ≥ ${target}, margin ${tempMarginC.toFixed(0)} °C`);
    return {
      componentId: comp.id, name: comp.name, sf: round(sf, 3), maxStressMPa: round(stress, 2), gaugeStressMPa: gauge === undefined ? undefined : round(gauge, 2),
      deflectionMm: round(a.deflectionMm, 3), tempC: round(tempC, 2), tempMarginC: round(tempMarginC, 2), loadScale: round(loadScale, 3), status, messages,
    };
  });
  return {
    at: new Date().toISOString(),
    source: readings ? 'telemetry' : 'design',
    targetSafetyFactor: target,
    overall: components.reduce<Status>((s, c) => worst(s, c.status), 'ok'),
    components,
    rules: VERIFY_RULES,
  };
}
