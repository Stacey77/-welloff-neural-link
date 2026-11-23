import { randomUUID } from 'crypto';
import { analyze, round } from './analysis.js';
import { getMaterial } from './materials.js';
import { verifyDesign, type ComponentReading } from './verify.js';
import type { Alert, ChannelDef, Project, Reading, Sample, VerificationReport } from './types.js';

export const RING_SIZE = 600;
const MAX_ALERTS = 500;
const STALE_MS = 60_000;

export type TelemetryEvent =
  | { type: 'sample'; projectId: string; simulated: boolean; samples: Sample[] }
  | { type: 'verification'; projectId: string; report: VerificationReport }
  | { type: 'alert'; projectId: string; alert: Alert }
  | { type: 'status'; projectId: string; running: boolean; simulated: boolean };

export interface TelemetryStore {
  get(id: string): Project | null;
  save(p: Project, urgent?: boolean): void;
}

interface SimState { t: number; temp: Record<string, number>; heat: Record<string, number>; spike: Record<string, { left: number; factor: number }> }

const UNIT_CONVERT: Record<string, Record<string, (v: number) => number>> = {
  N: { kN: (v) => v * 1000, lbf: (v) => v * 4.44822 },
  MPa: { bar: (v) => v / 10, kPa: (v) => v / 1000, psi: (v) => v * 0.006895 },
  'N·m': { Nm: (v) => v, 'N.m': (v) => v, kNm: (v) => v * 1000 },
  '°C': { C: (v) => v, degC: (v) => v, K: (v) => v - 273.15, F: (v) => ((v - 32) * 5) / 9, '°F': (v) => ((v - 32) * 5) / 9 },
  'µε': { ue: (v) => v, microstrain: (v) => v, strain: (v) => v * 1e6 },
};

function gauss(): number {
  return Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random());
}

export class TelemetryHub {
  private buffers = new Map<string, Map<string, Sample[]>>();
  private subs = new Map<string, Set<(e: TelemetryEvent) => void>>();
  private sims = new Map<string, NodeJS.Timeout>();
  private simState = new Map<string, SimState>();

  constructor(private store: TelemetryStore) {}

  subscribe(projectId: string, fn: (e: TelemetryEvent) => void): () => void {
    let set = this.subs.get(projectId);
    if (!set) { set = new Set(); this.subs.set(projectId, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.subs.delete(projectId); };
  }

  private allSubs = new Set<(e: TelemetryEvent) => void>();

  subscribeAll(fn: (e: TelemetryEvent) => void): () => void {
    this.allSubs.add(fn);
    return () => { this.allSubs.delete(fn); };
  }

  private emit(e: TelemetryEvent): void {
    for (const fn of [...(this.subs.get(e.projectId) ?? []), ...this.allSubs]) {
      try { fn(e); } catch { /* a failing subscriber must not stop the stream */ }
    }
  }

  history(projectId: string, channel?: string): Record<string, Sample[]> {
    const b = this.buffers.get(projectId);
    if (!b) return {};
    return channel ? { [channel]: [...(b.get(channel) ?? [])] } : Object.fromEntries([...b.entries()].map(([k, v]) => [k, [...v]]));
  }

  isRunning(projectId: string): boolean {
    return this.sims.has(projectId);
  }

  forget(projectId: string): void {
    this.stopSimulation(projectId, false);
    this.buffers.delete(projectId);
    this.subs.delete(projectId);
    this.simState.delete(projectId);
  }

  ingest(projectId: string, readings: Reading[], simulated = false): { accepted: number; rejected: { channel: string; reason: string }[]; verification: VerificationReport; alerts: Alert[] } {
    const p = this.store.get(projectId);
    if (!p) throw new Error(`unknown project ${projectId}`);
    const rejected: { channel: string; reason: string }[] = [];
    const samples: Sample[] = [];
    for (const r of readings) {
      const def = p.telemetry.channels.find((c) => c.channel === r?.channel);
      if (!def) { rejected.push({ channel: String(r?.channel), reason: 'unknown channel' }); continue; }
      let value = typeof r.value === 'number' ? r.value : Number(r.value);
      if (!Number.isFinite(value)) { rejected.push({ channel: def.channel, reason: 'value is not a finite number' }); continue; }
      if (r.unit && r.unit !== def.unit) {
        const conv = UNIT_CONVERT[def.unit]?.[r.unit];
        if (!conv) { rejected.push({ channel: def.channel, reason: `unit ${r.unit} cannot be converted to ${def.unit}` }); continue; }
        value = conv(value);
      }
      const at = r.at && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
      samples.push({ channel: def.channel, value, unit: def.unit, at, simulated });
    }
    let b = this.buffers.get(projectId);
    if (!b) { b = new Map(); this.buffers.set(projectId, b); }
    for (const s of samples) {
      let ring = b.get(s.channel);
      if (!ring) { ring = []; b.set(s.channel, ring); }
      ring.push(s);
      if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
      p.telemetry.latest[s.channel] = s;
    }
    if (samples.length) this.emit({ type: 'sample', projectId, simulated, samples });

    const report = verifyDesign(p, readingsFromLatest(p));
    p.telemetry.lastVerification = report;
    this.emit({ type: 'verification', projectId, report });
    const alerts = this.updateAlerts(p, report, simulated);
    for (const alert of alerts) this.emit({ type: 'alert', projectId, alert });
    p.updatedAt = new Date().toISOString();
    this.store.save(p, alerts.length > 0);
    return { accepted: samples.length, rejected, verification: report, alerts };
  }

  // One alert per breach key; it re-fires only after the breach has cleared and recurred.
  private updateAlerts(p: Project, report: VerificationReport, simulated: boolean): Alert[] {
    const now = new Date().toISOString();
    const breaches = new Map<string, Omit<Alert, 'id' | 'key' | 'at' | 'simulated'>>();
    for (const c of report.components) {
      const target = report.targetSafetyFactor;
      if (c.sf < 1) breaches.set(`${c.componentId}:sf:fail`, { componentId: c.componentId, severity: 'fail', kind: 'safety_factor', message: `${c.name}: SF ${c.sf.toFixed(2)} < 1.0 (σ ${c.maxStressMPa.toFixed(1)} MPa at ${c.loadScale.toFixed(2)}× nominal load)`, value: c.sf });
      else if (c.sf < target) breaches.set(`${c.componentId}:sf:warn`, { componentId: c.componentId, severity: 'warn', kind: 'safety_factor', message: `${c.name}: SF ${c.sf.toFixed(2)} below target ${target} at ${c.loadScale.toFixed(2)}× nominal load`, value: c.sf });
      if (c.tempMarginC < 0) breaches.set(`${c.componentId}:temp:fail`, { componentId: c.componentId, severity: 'fail', kind: 'temperature', message: `${c.name}: ${c.tempC.toFixed(1)} °C exceeds max service temperature`, value: c.tempC });
      else if (c.tempMarginC < 15) breaches.set(`${c.componentId}:temp:warn`, { componentId: c.componentId, severity: 'warn', kind: 'temperature', message: `${c.name}: temperature margin ${c.tempMarginC.toFixed(1)} °C < 15 °C`, value: c.tempC });
      if (c.messages.some((m) => m.startsWith('deflection'))) breaches.set(`${c.componentId}:deflection:warn`, { componentId: c.componentId, severity: 'warn', kind: 'deflection', message: `${c.name}: ${c.messages.find((m) => m.startsWith('deflection'))}`, value: c.deflectionMm });
    }
    const open = new Map(p.alerts.filter((a) => !a.clearedAt).map((a) => [a.key, a]));
    for (const [key, a] of open) if (!breaches.has(key)) a.clearedAt = now;
    const fresh: Alert[] = [];
    for (const [key, b] of breaches) {
      if (open.has(key)) continue;
      const alert: Alert = { id: randomUUID().slice(0, 8), key, at: now, simulated, ...b };
      p.alerts.push(alert);
      fresh.push(alert);
    }
    if (p.alerts.length > MAX_ALERTS) p.alerts.splice(0, p.alerts.length - MAX_ALERTS);
    return fresh;
  }

  /* ── Simulator: every sample it emits carries simulated: true ── */

  startSimulation(projectId: string, intervalMs = 1000): void {
    const p = this.store.get(projectId);
    if (!p) throw new Error(`unknown project ${projectId}`);
    if (this.sims.has(projectId)) return;
    const timer = setInterval(() => this.safeTick(projectId), Math.max(200, intervalMs));
    timer.unref?.();
    this.sims.set(projectId, timer);
    p.telemetry.running = true;
    p.telemetry.simulated = true;
    this.store.save(p, true);
    this.emit({ type: 'status', projectId, running: true, simulated: true });
  }

  stopSimulation(projectId: string, persist = true): void {
    const timer = this.sims.get(projectId);
    if (timer) clearInterval(timer);
    this.sims.delete(projectId);
    const p = persist ? this.store.get(projectId) : null;
    if (p) {
      p.telemetry.running = false;
      this.store.save(p, true);
      this.emit({ type: 'status', projectId, running: false, simulated: p.telemetry.simulated });
    }
  }

  private safeTick(projectId: string): void {
    try { this.simulateTick(projectId); } catch (err) {
      console.error('[engineering] simulator tick failed', err instanceof Error ? err.message : err);
      this.stopSimulation(projectId);
    }
  }

  simulateTick(projectId: string) {
    const p = this.store.get(projectId);
    if (!p) throw new Error(`unknown project ${projectId}`);
    let st = this.simState.get(projectId);
    if (!st) { st = { t: 0, temp: {}, heat: {}, spike: {} }; this.simState.set(projectId, st); }
    st.t++;
    const readings: Reading[] = [];
    const byComp = new Map<string, ChannelDef[]>();
    for (const ch of p.telemetry.channels) byComp.set(ch.componentId, [...(byComp.get(ch.componentId) ?? []), ch]);
    for (const [cid, chans] of byComp) {
      const comp = p.plan.components.find((c) => c.id === cid);
      const design = p.designs.find((d) => d.componentId === cid);
      const mat = design && getMaterial(design.materialId);
      if (!comp || !design || !mat) continue;
      const sp = st.spike[cid];
      if (sp && sp.left > 0) sp.left--;
      else if (Math.random() < 0.06) st.spike[cid] = { left: 1 + Math.floor(Math.random() * 3), factor: 1.8 + Math.random() * 1.8 };
      const spike = st.spike[cid]?.left ? st.spike[cid].factor : 1;
      const scale = Math.max(0, (1 + 0.04 * gauss() + 0.08 * Math.sin((2 * Math.PI * st.t) / 30)) * spike);
      if ((st.heat[cid] ?? 0) > 0) st.heat[cid]--;
      else if (Math.random() < 0.01) st.heat[cid] = 10;
      const base = st.temp[cid] ?? comp.operatingTempC;
      const drift = (comp.operatingTempC + 3 - base) * 0.05 + 0.3 * gauss() + ((st.heat[cid] ?? 0) > 0 ? 1.5 : 0);
      const temp = st.temp[cid] = base + drift;
      for (const ch of chans) {
        if (ch.kind === 'load') readings.push({ channel: ch.channel, value: round(ch.nominal * scale, 3), unit: ch.unit });
        else if (ch.kind === 'temperature') readings.push({ channel: ch.channel, value: round(temp, 2), unit: ch.unit });
        else {
          const sigma = analyze(comp, mat, design.section, { loadScale: scale, tempC: temp, elements: 10 }).maxStressMPa;
          readings.push({ channel: ch.channel, value: round((sigma / mat.eGPa) * 1000 * (1 + 0.03 * gauss()), 2), unit: ch.unit });
        }
      }
    }
    return this.ingest(projectId, readings, true);
  }
}

export function readingsFromLatest(p: Project): Record<string, ComponentReading> {
  const out: Record<string, ComponentReading> = {};
  const newest = Math.max(0, ...Object.values(p.telemetry.latest).map((s) => Date.parse(s.at) || 0));
  for (const ch of p.telemetry.channels) {
    const s = p.telemetry.latest[ch.channel];
    if (!s || newest - (Date.parse(s.at) || 0) > STALE_MS) continue;
    const r = (out[ch.componentId] ??= {});
    if (ch.kind === 'load') r.load = s.value;
    else if (ch.kind === 'temperature') r.tempC = s.value;
    else r.strainMicro = s.value;
  }
  return out;
}
