export type GeometryType = 'bracket' | 'beam' | 'shaft' | 'plate' | 'pressure_vessel' | 'frame';
export type SupportType = 'cantilever' | 'simply_supported' | 'fixed_fixed';
export type SectionShape = 'rect' | 'round' | 'tube' | 'rhs' | 'ibeam';
export type Priority = 'mass' | 'cost' | 'balanced';
export type Status = 'ok' | 'warn' | 'fail';

// All section dimensions in mm.
export interface Section {
  shape: SectionShape;
  b?: number;
  h?: number;
  d?: number;
  D?: number;
  t?: number;
  tf?: number;
  tw?: number;
}

// Service (unfactored) loads.
export interface Loads {
  pointN: number;
  pointAtFrac: number;
  udlNPerM: number;
  torqueNm: number;
  pressureMPa: number;
}

export interface ComponentSpec {
  id: string;
  name: string;
  geometry: GeometryType;
  support: SupportType;
  lengthMm: number;
  widthMm?: number;
  diameterMm?: number;
  loads: Loads;
  operatingTempC: number;
  cyclic: boolean;
  corrosive: boolean;
  materialHint?: string;
  notes: string[];
}

export interface Requirements {
  targetSafetyFactor: number;
  priority: Priority;
  dynamicFactor: number;
  tempMarginC: number;
  notes: string[];
}

export interface Plan {
  summary: string;
  components: ComponentSpec[];
  requirements: Requirements;
  assumptions: string[];
}

export interface AnalysisResult {
  method: string;
  approximation?: string;
  loadScale: number;
  tempC: number;
  bendingStressMPa: number;
  shearStressMPa: number;
  hoopStressMPa: number;
  thermalStressMPa: number;
  thermalIncluded: boolean;
  maxStressMPa: number;
  allowableMPa: number;
  sf: number;
  deflectionMm: number;
  deflectionLimitMm: number;
  diagram?: { xMm: number; momentNm: number; deflectionMm: number }[];
  reactions?: { dof: number; value: number }[];
}

export interface ComponentDesign {
  componentId: string;
  materialId: string;
  materialName: string;
  section: Section;
  dims: string;
  sizingOk: boolean;
  sizingIterations: number;
  massKg: number;
  process?: string;
  costIndex?: number;
  results: AnalysisResult;
}

export interface ComponentVerification {
  componentId: string;
  name: string;
  sf: number;
  maxStressMPa: number;
  gaugeStressMPa?: number;
  deflectionMm: number;
  tempC: number;
  tempMarginC: number;
  loadScale: number;
  status: Status;
  messages: string[];
}

export interface VerificationReport {
  at: string;
  source: 'design' | 'telemetry';
  targetSafetyFactor: number;
  overall: Status;
  components: ComponentVerification[];
  rules: string[];
}

export type NodeStatus = 'done' | 'warn' | 'fail' | 'skipped';

export interface SwarmNodeRun {
  id: string;
  name: string;
  status: NodeStatus;
  startedAt: string;
  ms: number;
  summary: string;
  outputs: unknown;
}

export interface ChannelDef {
  channel: string;
  componentId: string;
  kind: 'load' | 'temperature' | 'strain';
  unit: string;
  location: string;
  nominal: number;
}

export interface Reading {
  channel: string;
  value: number;
  unit?: string;
  at?: string;
}

export interface Sample {
  channel: string;
  value: number;
  unit: string;
  at: string;
  simulated: boolean;
}

export interface Alert {
  id: string;
  key: string;
  at: string;
  clearedAt?: string;
  componentId: string;
  severity: 'warn' | 'fail';
  kind: string;
  message: string;
  value: number;
  simulated: boolean;
}

export interface Finding {
  rule: string;
  componentId: string;
  severity: 'info' | 'warn' | 'fail';
  message: string;
}

export interface Project {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  planSource: 'llm' | 'rules';
  planModel?: string;
  planNotes: string[];
  plan: Plan;
  swarm: { nodes: SwarmNodeRun[]; levels: string[][]; ms: number };
  designs: ComponentDesign[];
  compliance: { compliant: boolean; findings: Finding[]; rulesApplied: string[]; references: { standard: string; scope: string; note: string }[] };
  report: { text: string; source: 'llm' | 'rules'; model?: string };
  verification: VerificationReport;
  telemetry: { running: boolean; simulated: boolean; channels: ChannelDef[]; latest: Record<string, Sample>; lastVerification?: VerificationReport };
  alerts: Alert[];
}

export interface ProjectOptions {
  targetSafetyFactor?: number;
  priority?: Priority;
  model?: string;
  llm?: boolean;
}
