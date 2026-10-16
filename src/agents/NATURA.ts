import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { AgentCommand } from '../types/index.js';
import { callMcpTool } from '../connectors/mcp-client.js';
import { recordTokenUsage } from '../observability/metrics.js';

const claude = new Anthropic();

const SYSTEM = `You are NATURA, the Natural Sciences Intelligence agent for the WellOff platform.

You are an expert in:
- BOTANY: Plant identification, physiology, taxonomy, medicinal plants, crop science, forest ecology, mycology
- ZOOLOGY: Animal behavior, taxonomy, physiology, wildlife biology, marine biology, conservation
- ENTOMOLOGY: Insect identification, behavior, ecology, pest management, beneficial insects, pollinator health
- ECOLOGY: Ecosystems, food webs, biomes, biodiversity, habitat analysis, species interactions, conservation biology
- EARTH SCIENCE: Geology, meteorology, soil science, hydrology, climate science, geochemistry
- MICROBIOLOGY: Bacteria, viruses, fungi, microbiome, fermentation, extremophiles
- EVOLUTION: Phylogenetics, natural selection, adaptation, speciation, paleontology
- ENVIRONMENTAL SCIENCE: Pollution, climate change, sustainability, conservation, ecological impact assessment

When analyzing nature-related queries:
1. Provide scientifically accurate information with proper taxonomy (Latin names)
2. Include ecological context and relationships
3. Mention conservation status when relevant (IUCN categories)
4. Connect to practical applications (agriculture, medicine, environmental management)
5. Note any climate change impacts or threats

Return structured responses with: identification, description, habitat, ecology, significance, and actionable insights.`;

export async function handle(command: AgentCommand): Promise<unknown> {
  const p = (command.params ?? {}) as Record<string, unknown>;
  const message = typeof p.message === 'string' ? p.message : command.command;

  switch (command.command) {
    case 'identifySpecies':
    case 'analyzeEcosystem':
    case 'trackBiodiversity':
    case 'researchConservation':
    case 'diagnosePlantDisease':
    case 'classifyInsect':
    case 'analyzeSoil':
    case 'predictWildlifeMigration':
    case 'searchScientificLiterature':
    case 'modelClimateImpact': {
      const commandPrompts: Record<string, string> = {
        identifySpecies: `Identify and describe this species: ${JSON.stringify(p.description ?? p.image_url ?? p)}`,
        analyzeEcosystem: `Perform an ecological analysis of: ${JSON.stringify(p.location ?? p.ecosystem ?? p)}`,
        trackBiodiversity: `Analyze biodiversity metrics and trends for: ${JSON.stringify(p.region ?? p.habitat ?? p)}`,
        researchConservation: `Provide conservation research and strategies for: ${JSON.stringify(p.species ?? p.habitat ?? p)}`,
        diagnosePlantDisease: `Diagnose this plant condition and recommend treatment: ${JSON.stringify(p.symptoms ?? p.plant ?? p)}`,
        classifyInsect: `Classify and describe this insect, including its role in the ecosystem: ${JSON.stringify(p.description ?? p)}`,
        analyzeSoil: `Analyze soil composition, health indicators, and recommendations: ${JSON.stringify(p.samples ?? p.location ?? p)}`,
        predictWildlifeMigration: `Model wildlife migration patterns and predictions for: ${JSON.stringify(p.species ?? p.region ?? p)}`,
        searchScientificLiterature: `Search and synthesize scientific literature on: ${JSON.stringify(p.topic ?? p.query ?? p)}`,
        modelClimateImpact: `Model climate change impacts on: ${JSON.stringify(p.ecosystem ?? p.species ?? p.region ?? p)}`,
      };

      const prompt = commandPrompts[command.command] ?? message;
      const messages: MessageParam[] = [{ role: 'user', content: prompt }];

      const response = await claude.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM,
        messages,
      });

      recordTokenUsage('NATURA', response.usage);

      const text = response.content.find(b => b.type === 'text');
      return {
        agent: 'NATURA',
        command: command.command,
        analysis: text?.type === 'text' ? text.text : 'Analysis complete',
        domain: inferDomain(command.command),
      };
    }

    case 'reason':
    case 'query': {
      const messages: MessageParam[] = [{ role: 'user', content: message }];
      const response = await claude.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM,
        messages,
      });

      recordTokenUsage('NATURA', response.usage);

      const text = response.content.find(b => b.type === 'text');
      return {
        agent: 'NATURA',
        response: text?.type === 'text' ? text.text : 'Query processed',
      };
    }

    case 'callMcpTool': {
      const tool = String(p.tool ?? '');
      return callMcpTool(tool, p.params as Record<string, unknown> ?? {});
    }

    default:
      // Natural language fallback — answer any nature/science question
      if (message && message !== command.command) {
        const response = await claude.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: SYSTEM,
          messages: [{ role: 'user', content: message }],
        });
        recordTokenUsage('NATURA', response.usage);
        const text = response.content.find(b => b.type === 'text');
        return { agent: 'NATURA', response: text?.type === 'text' ? text.text : 'Processed' };
      }
      throw new Error(`NATURA: unknown command "${command.command}"`);
  }
}

function inferDomain(cmd: string): string {
  if (cmd.includes('Plant') || cmd.includes('Soil')) return 'Botany / Plant Science';
  if (cmd.includes('Insect') || cmd.includes('insect')) return 'Entomology';
  if (cmd.includes('Wildlife') || cmd.includes('Species')) return 'Zoology / Wildlife Biology';
  if (cmd.includes('Ecosystem') || cmd.includes('Biodiversity')) return 'Ecology';
  if (cmd.includes('Climate')) return 'Environmental Science / Climate Science';
  if (cmd.includes('Conservation')) return 'Conservation Biology';
  if (cmd.includes('Literature')) return 'Scientific Research';
  return 'Natural Sciences';
}
