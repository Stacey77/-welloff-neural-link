// What each agent can do, used by the head orchestrator to plan jobs. Commands marked
// `act` change something outside the platform (spend money, deploy, send, write files)
// and only run after a person approves them.

export interface Capability {
  agent: string;
  description: string;
  keywords: string[];
  read: string[];
  act: string[];
  defaultCommand: string;
  messageParam?: boolean;
}

export const REGISTRY: Capability[] = [
  { agent: 'ARIA', description: 'Real estate leads, Meta ads, lead enrichment and follow-ups', keywords: ['lead', 'leads', 'fsbo', 'seller', 'meta', 'facebook', 'instagram', 'ad campaign', 'follow-up', 'followup'], read: ['listCampaigns', 'getCampaignInsights', 'getLeadFormSubmissions', 'findLeads', 'enrichLead'], act: ['createCampaign', 'createAdSet', 'createLeadForm', 'updateCampaignStatus', 'killCampaigns', 'scheduleFollowup'], defaultCommand: 'findLeads' },
  { agent: 'DEVX', description: 'Google Ads, territory intelligence, zoning and permits', keywords: ['google ads', 'keyword', 'territory', 'zoning', 'permit', 'zip', 'search ads'], read: ['listGoogleCampaigns', 'getCampaignPerformance', 'getKeywordIdeas', 'getTerritoryIntel', 'findOpportunityZips', 'scanZoningChanges', 'analyzePermits'], act: ['createGoogleCampaign', 'createAdGroup'], defaultCommand: 'getTerritoryIntel' },
  { agent: 'TERRA', description: 'Land, parcels, GIS, tax records and comparable sales', keywords: ['parcel', 'land', 'gis', 'lot', 'acre', 'tax record', 'comps', 'movement score', 'property'], read: ['assessParcel', 'getPropertyDetails', 'searchGISData', 'searchProperties', 'getMovementScore', 'getTaxRecords', 'getComparableSales'], act: ['claimTerritory'], defaultCommand: 'searchProperties' },
  { agent: 'CAPITA', description: 'Commercial real estate investment, NNN leases, deal screening', keywords: ['commercial', 'nnn', 'cap rate', 'noi', 'deal', 'investment', 'loi', 'industrial', 'retail'], read: ['analyzeNNN', 'getComparableSales', 'screenDeals', 'searchProperties', 'getPropertyDetails'], act: ['generateDocument'], defaultCommand: 'screenDeals' },
  { agent: 'NOVA', description: 'Residential investment, rentals, foreclosures and listing media', keywords: ['rental', 'residential', 'foreclosure', 'flip', 'listing', 'staging', 'flyer', 'social post'], read: ['rentalAnalysis', 'searchProperties', 'foreclosureScreen', 'searchLeads'], act: ['generateSocialContent', 'createPropertyVideo', 'generateVirtualStaging', 'createPropertyFlyer'], defaultCommand: 'rentalAnalysis' },
  { agent: 'NEXUS', description: 'Tech sector intelligence: funding, SaaS metrics, acquisitions, talent', keywords: ['startup', 'funding', 'series', 'saas', 'acquisition', 'tech stack', 'talent', 'hiring'], read: ['scanTechFunding', 'trackSaasMetrics', 'findAcquisitionTargets', 'monitorTalentSignals', 'analyzeTechStack'], act: [], defaultCommand: 'scanTechFunding' },
  { agent: 'FORGE', description: 'Robot fleets: health, maintenance, simulation, sensor analysis', keywords: ['robot', 'fleet health', 'ros', 'lidar', 'path planning', 'maintenance'], read: ['getFleetStatus', 'runRosSimulation', 'analyzeSensorData', 'optimizePathPlanning'], act: ['scheduleMaintenance'], defaultCommand: 'getFleetStatus' },
  { agent: 'ARCH', description: 'Civil and structural engineering: BIM clashes, permits, loads, code', keywords: ['bim', 'structural', 'building code', 'civil', 'load calculation', 'construction cost'], read: ['runBimClashDetection', 'getPermitStatus', 'calculateStructuralLoads', 'checkCodeCompliance', 'estimateProjectCost'], act: [], defaultCommand: 'checkCodeCompliance' },
  { agent: 'VOLT', description: 'Mechanical engineering: FEA, materials, fatigue, DFMEA', keywords: ['fea', 'fatigue', 'dfmea', 'mechanical', 'stress analysis', 'geometry'], read: ['runFeaAnalysis', 'selectMaterial', 'analyzeFatigueFailure', 'optimizeGeometry', 'generateDfmea'], act: [], defaultCommand: 'runFeaAnalysis' },
  { agent: 'MOTOR', description: 'Automotive: fleet telemetry, fault codes, EV batteries, ADAS, emissions', keywords: ['vehicle', 'fault code', 'obd', 'ev battery', 'adas', 'emissions', 'telematics'], read: ['getFleetTelemetry', 'diagnoseFaultCode', 'analyzeBatteryHealth', 'checkAdasCalibration', 'runEmissionsCompliance'], act: [], defaultCommand: 'getFleetTelemetry' },
  { agent: 'MESH', description: 'Networks: topology, traffic anomalies, firewall audits, CVE scans, IaC', keywords: ['network', 'firewall', 'cve', 'vulnerability', 'traffic', 'vpc', 'terraform'], read: ['mapNetworkTopology', 'detectTrafficAnomalies', 'auditFirewallRules', 'scanVulnerabilities', 'generateIac'], act: [], defaultCommand: 'scanVulnerabilities' },
  { agent: 'INFRA', description: 'Cloud infrastructure (IaaS): compute, storage, networking, cost', keywords: ['server', 'compute', 'storage', 'cloud cost', 'autoscale', 'instance'], read: ['monitorInfrastructure', 'optimizeCosts'], act: ['provisionCompute', 'manageStorage', 'configureNetworking', 'autoScaleResource'], defaultCommand: 'monitorInfrastructure' },
  { agent: 'PLAT', description: 'Platform (PaaS): deployments, pipelines, databases, scaling', keywords: ['deploy', 'pipeline', 'ci/cd', 'database', 'runtime', 'scale service'], read: ['monitorPlatform'], act: ['deployApplication', 'managePipeline', 'provisionDatabase', 'scaleService', 'manageRuntime'], defaultCommand: 'monitorPlatform' },
  { agent: 'XAAS', description: 'As-a-service operations: tenants, billing, SLAs, API gateway', keywords: ['tenant', 'billing', 'sla', 'api gateway', 'white label', 'service catalog'], read: ['generateServiceCatalog'], act: ['provisionTenant', 'manageBilling', 'enforceSla', 'manageApiGateway', 'deployWhiteLabel'], defaultCommand: 'generateServiceCatalog' },
  { agent: 'NATURA', description: 'Nature and life sciences: plants, animals, insects, soil, ecology, climate', keywords: ['plant', 'animal', 'insect', 'species', 'soil', 'ecosystem', 'wildlife', 'garden', 'crop', 'pollinator', 'climate'], read: ['query', 'identifySpecies', 'analyzeEcosystem', 'diagnosePlantDisease', 'classifyInsect', 'analyzeSoil', 'modelClimateImpact', 'searchScientificLiterature'], act: [], defaultCommand: 'query', messageParam: true },
  { agent: 'AXIOM', description: 'Engineering orchestration: plan, size and verify a design from a goal', keywords: ['design', 'bracket', 'beam', 'shaft', 'pressure vessel', 'engineer', 'safety factor', 'prototype'], read: ['plan', 'status', 'list', 'verify'], act: ['simulate'], defaultCommand: 'plan' },
  { agent: 'MORTEX', description: 'Materials selection', keywords: ['material', 'alloy', 'steel', 'aluminium', 'aluminum', 'titanium', 'polymer'], read: ['select', 'library'], act: [], defaultCommand: 'library' },
  { agent: 'SENTINEL', description: 'Safety compliance and live engineering alerts', keywords: ['compliance', 'safety check', 'telemetry alert'], read: ['check', 'alerts'], act: [], defaultCommand: 'alerts' },
  { agent: 'EVE', description: 'Memory of LLCs, clients, projects, prospects, deadlines and bookings', keywords: ['client', 'prospect', 'deadline', 'booking', 'llc', 'remind', 'meeting'], read: ['recall', 'list', 'notifications'], act: ['remember', 'event'], defaultCommand: 'recall' },
  { agent: 'MAESTRO', description: 'Multi-model answers: route, compare and judge across LLMs', keywords: ['compare models', 'second opinion', 'which model'], read: ['ask', 'route', 'compare', 'council', 'providers'], act: ['setPolicy', 'assign', 'discover'], defaultCommand: 'ask' },
  { agent: 'BRAIN', description: 'Long-horizon reasoning, planning and cross-domain synthesis with memory', keywords: ['strategy', 'plan', 'synthesize', 'long-term'], read: ['reason'], act: [], defaultCommand: 'reason', messageParam: true },
  { agent: 'LINDY', description: 'Send a payload to a Lindy.ai workflow (email, CRM, calendar)', keywords: ['lindy', 'send email', 'crm'], read: ['status'], act: ['trigger'], defaultCommand: 'status' },
  { agent: 'GENESIS', description: 'Generate a new agent source file', keywords: ['new agent', 'generate agent'], read: ['describeCapabilities'], act: ['generateAgent'], defaultCommand: 'describeCapabilities' },
];

export function capability(agent: string): Capability | undefined {
  return REGISTRY.find((c) => c.agent === agent.toUpperCase());
}

export function isAction(agent: string, command: string): boolean {
  const c = capability(agent);
  if (!c) return true;
  if (c.act.includes(command)) return true;
  return !c.read.includes(command);
}

export function registryText(): string {
  return REGISTRY.map((c) => `- ${c.agent}: ${c.description}. Read-only: ${c.read.join(', ') || 'none'}.${c.act.length ? ` Needs approval: ${c.act.join(', ')}.` : ''}`).join('\n');
}
