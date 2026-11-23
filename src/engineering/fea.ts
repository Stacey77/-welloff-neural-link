import type { Section, SupportType } from './types.js';

export interface SectionProps {
  areaM2: number;
  iM4: number;
  cM: number;
  jM4: number;
  label: string;
}

export function sectionProps(s: Section): SectionProps {
  const mm = 1e-3;
  switch (s.shape) {
    case 'rect': {
      const b = s.b! * mm, h = s.h! * mm;
      const a = Math.max(b, h), c = Math.min(b, h);
      const j = a * c ** 3 * (1 / 3 - 0.21 * (c / a) * (1 - c ** 4 / (12 * a ** 4)));
      return { areaM2: b * h, iM4: (b * h ** 3) / 12, cM: h / 2, jM4: j, label: `rect ${s.b}×${s.h} mm` };
    }
    case 'round': {
      const d = s.d! * mm;
      return { areaM2: (Math.PI * d ** 2) / 4, iM4: (Math.PI * d ** 4) / 64, cM: d / 2, jM4: (Math.PI * d ** 4) / 32, label: `Ø${s.d} mm bar` };
    }
    case 'tube': {
      const D = s.D! * mm, d = (s.D! - 2 * s.t!) * mm;
      const i = (Math.PI * (D ** 4 - d ** 4)) / 64;
      return { areaM2: (Math.PI * (D ** 2 - d ** 2)) / 4, iM4: i, cM: D / 2, jM4: 2 * i, label: `tube Ø${s.D}×${s.t} mm` };
    }
    case 'rhs': {
      const b = s.b! * mm, h = s.h! * mm, t = s.t! * mm;
      const bi = b - 2 * t, hi = h - 2 * t;
      const j = (2 * t * (b - t) ** 2 * (h - t) ** 2) / (b + h - 2 * t);
      return { areaM2: b * h - bi * hi, iM4: (b * h ** 3 - bi * hi ** 3) / 12, cM: h / 2, jM4: j, label: `RHS ${s.h}×${s.b}×${s.t} mm` };
    }
    case 'ibeam': {
      const b = s.b! * mm, h = s.h! * mm, tf = s.tf! * mm, tw = s.tw! * mm;
      const hw = h - 2 * tf;
      const j = (2 * b * tf ** 3 + hw * tw ** 3) / 3;
      return { areaM2: 2 * b * tf + hw * tw, iM4: (b * h ** 3 - (b - tw) * hw ** 3) / 12, cM: h / 2, jM4: j, label: `I-beam h${s.h} b${s.b} tf${s.tf} tw${s.tw} mm (approx., no root radii)` };
    }
  }
}

export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    if (Math.abs(M[p][k]) < 1e-300) throw new Error('Singular stiffness matrix: the structure is a mechanism (check supports).');
    if (p !== k) [M[p], M[k]] = [M[k], M[p]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      if (f === 0) continue;
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

export interface BeamModel {
  lengthM: number;
  ePa: number;
  iM4: number;
  cM: number;
  support: SupportType;
  elements?: number;
  pointLoads: { xM: number; N: number }[];
  udlNPerM: number;
}

export interface BeamResult {
  xM: number[];
  deflectionM: number[];
  momentNm: number[];
  maxDeflectionM: number;
  maxMomentNm: number;
  maxStressPa: number;
  reactions: { dof: number; value: number }[];
}

function elementK(EI: number, L: number): number[][] {
  const k = EI / L ** 3;
  return [
    [12 * k, 6 * L * k, -12 * k, 6 * L * k],
    [6 * L * k, 4 * L * L * k, -6 * L * k, 2 * L * L * k],
    [-12 * k, -6 * L * k, 12 * k, -6 * L * k],
    [6 * L * k, 2 * L * L * k, -6 * L * k, 4 * L * L * k],
  ];
}

export function fixedDofs(support: SupportType, nNodes: number): number[] {
  const last = 2 * (nNodes - 1);
  if (support === 'cantilever') return [0, 1];
  if (support === 'simply_supported') return [0, last];
  return [0, 1, last, last + 1];
}

// Euler–Bernoulli beam, Hermite cubic elements, 2 DOF per node (w, θ).
export function solveBeam(m: BeamModel): BeamResult {
  const n = Math.max(2, Math.round(m.elements ?? 20));
  const L = m.lengthM / n;
  const EI = m.ePa * m.iM4;
  const nDof = 2 * (n + 1);
  const K = Array.from({ length: nDof }, () => new Array<number>(nDof).fill(0));
  const F = new Array<number>(nDof).fill(0);
  const ke = elementK(EI, L);
  const w = m.udlNPerM;
  const feq = [w * L / 2, w * L * L / 12, w * L / 2, -w * L * L / 12];
  for (let e = 0; e < n; e++) {
    const dofs = [2 * e, 2 * e + 1, 2 * e + 2, 2 * e + 3];
    for (let i = 0; i < 4; i++) {
      F[dofs[i]] += feq[i];
      for (let j = 0; j < 4; j++) K[dofs[i]][dofs[j]] += ke[i][j];
    }
  }
  for (const p of m.pointLoads) {
    const node = Math.min(n, Math.max(0, Math.round((p.xM / m.lengthM) * n)));
    F[2 * node] += p.N;
  }
  const fixed = new Set(fixedDofs(m.support, n + 1));
  const free = [...Array(nDof).keys()].filter((d) => !fixed.has(d));
  const Kr = free.map((i) => free.map((j) => K[i][j]));
  const ur = solveLinear(Kr, free.map((i) => F[i]));
  const u = new Array<number>(nDof).fill(0);
  free.forEach((d, i) => { u[d] = ur[i]; });

  const reactions = [...fixed].map((d) => ({ dof: d, value: K[d].reduce((s, k, j) => s + k * u[j], 0) - F[d] }));
  const moment = new Array<number>(n + 1).fill(0);
  for (let e = 0; e < n; e++) {
    const ue = [u[2 * e], u[2 * e + 1], u[2 * e + 2], u[2 * e + 3]];
    const f = ke.map((row, i) => row.reduce((s, k, j) => s + k * ue[j], 0) - feq[i]);
    if (e === 0) moment[0] = -f[1];
    moment[e + 1] = f[3];
  }
  const xM = Array.from({ length: n + 1 }, (_, i) => i * L);
  const deflectionM = xM.map((_, i) => u[2 * i]);
  const maxMomentNm = Math.max(...moment.map(Math.abs));
  return {
    xM, deflectionM, momentNm: moment,
    maxDeflectionM: Math.max(...deflectionM.map(Math.abs)),
    maxMomentNm,
    maxStressPa: (maxMomentNm * m.cM) / m.iM4,
    reactions,
  };
}

export function torsionShearPa(torqueNm: number, s: SectionProps): number {
  return (torqueNm * s.cM) / s.jM4;
}

// Thin-wall hoop and axial stress using mean radius; valid for r/t ≥ 10.
export function vesselStressPa(pPa: number, outerDiaM: number, tM: number): { hoop: number; axial: number; rOverT: number } {
  const r = (outerDiaM - tM) / 2;
  return { hoop: (pPa * r) / tM, axial: (pPa * r) / (2 * tM), rOverT: r / tM };
}

export function thermalStressPa(ePa: number, alphaPerK: number, dT: number): number {
  return ePa * alphaPerK * dT;
}

export interface SelfTestCase { name: string; quantity: string; fe: number; exact: number; relError: number }

export function selfTest(elements = 20): { elements: number; cases: SelfTestCase[]; maxRelError: number; pass: boolean } {
  const E = 210e9, sec = sectionProps({ shape: 'rect', b: 20, h: 40 }), I = sec.iM4, c = sec.cM;
  const L = 1.0, P = 1000, w = 2000;
  const cases: SelfTestCase[] = [];
  const add = (name: string, quantity: string, fe: number, exact: number) => cases.push({ name, quantity, fe, exact, relError: Math.abs(fe - exact) / Math.abs(exact) });
  const base = { lengthM: L, ePa: E, iM4: I, cM: c, elements };

  const cant = solveBeam({ ...base, support: 'cantilever', pointLoads: [{ xM: L, N: P }], udlNPerM: 0 });
  add('cantilever, tip load', 'tip deflection P·L³/(3EI) [m]', cant.deflectionM[elements], (P * L ** 3) / (3 * E * I));
  add('cantilever, tip load', 'max stress P·L·c/I [Pa]', cant.maxStressPa, (P * L * c) / I);

  const ssu = solveBeam({ ...base, support: 'simply_supported', pointLoads: [], udlNPerM: w });
  add('simply supported, UDL', 'midspan deflection 5wL⁴/(384EI) [m]', ssu.deflectionM[elements / 2], (5 * w * L ** 4) / (384 * E * I));
  add('simply supported, UDL', 'max stress (wL²/8)·c/I [Pa]', ssu.maxStressPa, ((w * L * L) / 8 * c) / I);

  const ssp = solveBeam({ ...base, support: 'simply_supported', pointLoads: [{ xM: L / 2, N: P }], udlNPerM: 0 });
  add('simply supported, midspan load', 'midspan deflection P·L³/(48EI) [m]', ssp.deflectionM[elements / 2], (P * L ** 3) / (48 * E * I));

  const ff = solveBeam({ ...base, support: 'fixed_fixed', pointLoads: [], udlNPerM: w });
  add('fixed-fixed, UDL', 'midspan deflection wL⁴/(384EI) [m]', ff.deflectionM[elements / 2], (w * L ** 4) / (384 * E * I));
  add('fixed-fixed, UDL', 'end moment wL²/12 [N·m]', ff.maxMomentNm, (w * L * L) / 12);

  const maxRelError = Math.max(...cases.map((x) => x.relError));
  return { elements, cases, maxRelError, pass: maxRelError < 0.01 };
}
