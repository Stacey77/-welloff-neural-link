import { callMcpTool } from '../connectors/mcp-client.js';
import { a2aBus } from '../a2a/bus.js';

interface ScheduledJob {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  lastRunAt?: number;
  runCount: number;
  errorCount: number;
}

const jobs = new Map<string, ScheduledJob>();

export function scheduleJob(name: string, intervalMs: number, handler: () => Promise<void>): void {
  const job: ScheduledJob = { name, intervalMs, handler, runCount: 0, errorCount: 0 };
  const wrapped = async () => {
    job.lastRunAt = Date.now();
    job.runCount++;
    try {
      console.log(`[scheduler] running: ${name}`);
      await handler();
    } catch (err) {
      job.errorCount++;
      console.error(`[scheduler] job ${name} failed:`, err instanceof Error ? err.message : err);
    }
  };
  job.timer = setInterval(wrapped, intervalMs);
  jobs.set(name, job);
}

export function startScheduler(): void {
  console.log('[scheduler] starting autonomous agents...');

  // ARIA: scan for new leads every hour
  scheduleJob('aria-lead-scan', 60 * 60 * 1000, async () => {
    const result = await callMcpTool('search_leads', { criteria: 'FSBO distressed motivated-seller', limit: 20, source: 'scheduled' });
    a2aBus.broadcast('ARIA', 'lead_alert', { source: 'aria-lead-scan', timestamp: Date.now(), leads: result });
  });

  // MESH: CVE scan every 24 hours
  scheduleJob('mesh-cve-scan', 24 * 60 * 60 * 1000, async () => {
    const result = await callMcpTool('scan_vulnerabilities', { scope: 'full', severity: ['critical', 'high'], source: 'scheduled' });
    a2aBus.broadcast('MESH', 'security_alert', { source: 'mesh-cve-scan', timestamp: Date.now(), vulnerabilities: result });
  });

  // FORGE: fleet health every 15 minutes
  scheduleJob('forge-fleet-health', 15 * 60 * 1000, async () => {
    const result = await callMcpTool('get_robot_fleet_status', { includeAlerts: true, source: 'scheduled' });
    a2aBus.broadcast('FORGE', 'fleet_alert', { source: 'forge-fleet-health', timestamp: Date.now(), fleet: result });
  });

  // INFRA: cost optimization check every 6 hours
  scheduleJob('infra-cost-scan', 6 * 60 * 60 * 1000, async () => {
    const result = await callMcpTool('optimize_costs', { scope: 'all', source: 'scheduled' });
    a2aBus.broadcast('INFRA', 'cost_alert', { source: 'infra-cost-scan', timestamp: Date.now(), report: result });
  });

  // BRAIN: cross-domain synthesis every 2 hours
  scheduleJob('brain-synthesis', 2 * 60 * 60 * 1000, async () => {
    a2aBus.broadcast('BRAIN', 'synthesis_trigger', { source: 'scheduled', timestamp: Date.now(), trigger: 'periodic-synthesis' });
  });

  console.log(`[scheduler] ${jobs.size} autonomous jobs scheduled`);
}

export function stopScheduler(): void {
  for (const job of jobs.values()) {
    if (job.timer) clearInterval(job.timer);
  }
  jobs.clear();
  console.log('[scheduler] stopped');
}

export function getSchedulerStatus() {
  return {
    jobCount: jobs.size,
    jobs: Array.from(jobs.values()).map(j => ({
      name: j.name,
      intervalMs: j.intervalMs,
      intervalHuman: j.intervalMs >= 3600000 ? `${j.intervalMs / 3600000}h` : j.intervalMs >= 60000 ? `${j.intervalMs / 60000}m` : `${j.intervalMs}ms`,
      lastRunAt: j.lastRunAt,
      runCount: j.runCount,
      errorCount: j.errorCount,
    })),
  };
}
