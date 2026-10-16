import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { route } from '../core/router.js';
import { McpCallSchema } from '../types/index.js';
import type { AgentId } from '../types/index.js';

export const mcpRouter = Router();

const TOOLS = [
  { name: 'ton_dispatch', agentId: 'TON', command: 'dispatch', description: 'Natural language dispatch — TON routes to the best agent automatically.' },
  { name: 'aria_listCampaigns', agentId: 'ARIA', command: 'listCampaigns', description: 'List all Meta Ads campaigns.' },
  { name: 'aria_createCampaign', agentId: 'ARIA', command: 'createCampaign', description: 'Create a new Meta Ads campaign.' },
  { name: 'aria_getCampaignInsights', agentId: 'ARIA', command: 'getCampaignInsights', description: 'Retrieve insights for a Meta Ads campaign.' },
  { name: 'aria_createLeadForm', agentId: 'ARIA', command: 'createLeadForm', description: 'Create a Meta Ads lead generation form.' },
  { name: 'aria_getLeadFormSubmissions', agentId: 'ARIA', command: 'getLeadFormSubmissions', description: 'Get submissions for a Meta Ads lead form.' },
  { name: 'aria_killCampaigns', agentId: 'ARIA', command: 'killCampaigns', description: 'Pause or delete Meta Ads campaigns.' },
  { name: 'aria_findLeads', agentId: 'ARIA', command: 'findLeads', description: 'Use AI to generate qualified lead criteria and strategies.' },
  { name: 'devx_listGoogleCampaigns', agentId: 'DEVX', command: 'listGoogleCampaigns', description: 'List all Google Ads campaigns.' },
  { name: 'devx_createGoogleCampaign', agentId: 'DEVX', command: 'createGoogleCampaign', description: 'Create a new Google Ads campaign.' },
  { name: 'devx_getCampaignPerformance', agentId: 'DEVX', command: 'getCampaignPerformance', description: 'Retrieve performance metrics for a Google Ads campaign.' },
  { name: 'devx_getKeywordIdeas', agentId: 'DEVX', command: 'getKeywordIdeas', description: 'Generate keyword ideas via Google Ads.' },
  { name: 'devx_analyzePermits', agentId: 'DEVX', command: 'analyzePermits', description: 'Analyze building permits and development opportunities with AI.' },
  { name: 'terra_assessParcel', agentId: 'TERRA', command: 'assessParcel', description: 'AI assessment of a land parcel for development potential.' },
  { name: 'terra_searchGISData', agentId: 'TERRA', command: 'searchGISData', description: 'AI-powered GIS data search and interpretation.' },
  { name: 'capita_analyzeNNN', agentId: 'CAPITA', command: 'analyzeNNN', description: 'AI analysis of an NNN lease investment.' },
  { name: 'capita_screenDeals', agentId: 'CAPITA', command: 'screenDeals', description: 'Screen commercial deals against investment criteria.' },
  { name: 'nova_rentalAnalysis', agentId: 'NOVA', command: 'rentalAnalysis', description: 'AI rental property cash-flow and yield analysis.' },
  { name: 'nova_foreclosureScreen', agentId: 'NOVA', command: 'foreclosureScreen', description: 'Screen foreclosure properties for investment viability.' },
];

const toolIndex = new Map(TOOLS.map((t) => [t.name, t]));

mcpRouter.get('/tools', (_req, res) => {
  res.json({ tools: TOOLS });
});

mcpRouter.post('/call', async (req, res) => {
  const parsed = McpCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { tool, params } = parsed.data;
  const toolDef = toolIndex.get(tool);

  if (!toolDef) {
    res.status(404).json({ error: `Unknown tool: ${tool}` });
    return;
  }

  const command = {
    id: randomUUID(),
    agentId: toolDef.agentId as AgentId,
    command: toolDef.command,
    params: (params ?? {}) as Record<string, unknown>,
    timestamp: Date.now(),
  };

  try {
    const result = await route(command);
    res.json({ tool, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
