import type { ProjectManager } from '../projects/manager.js';
import { autoLink } from '../auto-link/linker.js';
import { config } from '../config/index.js';

const INTERVAL_MS = 15 * 60_000; // 15 minutes
const BATCH_PER_PROJECT = 10;
const MIN_EDGE_THRESHOLD = 1;

let timer: ReturnType<typeof setInterval> | null = null;

const stats = {
  totalRepaired: 0,
  totalEdgesCreated: 0,
  totalErrors: 0,
  lastRunAt: null as string | null,
  consecutiveIdle: 0,
};

export function getLinkRepairStats() {
  return { ...stats };
}

async function repairOnce(manager: ProjectManager): Promise<void> {
  const projects = await manager.listProjects();
  let roundRepaired = 0;
  let roundEdges = 0;

  for (const project of projects) {
    const ctx = manager.getContext(project.slug);

    const isolated = await ctx.nodes.getIsolatedNodes(MIN_EDGE_THRESHOLD, BATCH_PER_PROJECT);
    if (isolated.length === 0) continue;

    for (const node of isolated) {
      try {
        const result = await autoLink(ctx, node.id, { useSimilarity: true });
        if (result.created_edges.length > 0) {
          roundRepaired++;
          roundEdges += result.created_edges.length;
        }
      } catch (err) {
        stats.totalErrors++;
        console.error(`[link-repair] Error for node ${node.id}:`, err);
      }
    }
  }

  stats.totalRepaired += roundRepaired;
  stats.totalEdgesCreated += roundEdges;
  stats.lastRunAt = new Date().toISOString();

  if (roundRepaired > 0) {
    stats.consecutiveIdle = 0;
    console.log(`[link-repair] Repaired ${roundRepaired} nodes, created ${roundEdges} edges`);
  } else {
    stats.consecutiveIdle++;
    if (stats.consecutiveIdle === 1 || stats.consecutiveIdle % 12 === 0) {
      console.log(`[link-repair] Idle (total repaired: ${stats.totalRepaired}, edges: ${stats.totalEdgesCreated})`);
    }
  }
}

export function startLinkRepair(manager: ProjectManager): void {
  if (!config.llmApiKey) {
    console.log('[link-repair] LLM_API_KEY not set, skipping link repair');
    return;
  }

  console.log('[link-repair] Started (interval: 15m)');

  setTimeout(() => {
    repairOnce(manager).catch(err => console.error('[link-repair] Initial run error:', err));
  }, 60_000);

  timer = setInterval(() => {
    repairOnce(manager).catch(err => console.error('[link-repair] Run error:', err));
  }, INTERVAL_MS);
}

export function stopLinkRepair(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
