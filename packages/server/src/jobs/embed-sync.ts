import type { ProjectManager } from '../projects/manager.js';
import { generateEmbeddings, getEmbeddingConfig, getEmbeddingText, EMBEDDABLE_TYPES } from '../index.js';

const INTERVAL_MS = 30_000; // 30 seconds
const BATCH_SIZE = 32;

let timer: ReturnType<typeof setInterval> | null = null;

// Cumulative stats for monitoring
const stats = {
  totalGenerated: 0,
  totalErrors: 0,
  totalSkipped: 0, // nodes where getEmbeddingText returns null
  lastRunAt: null as string | null,
  consecutiveIdle: 0,
};

export function getEmbedSyncStats() {
  return { ...stats };
}

async function syncOnce(manager: ProjectManager): Promise<void> {
  const projects = (await manager.listProjects()).filter(p => !p.slug.endsWith('-dev'));
  let roundGenerated = 0;
  let roundSkipped = 0;

  for (const project of projects) {
    const ctx = manager.getContext(project.slug);
    const pending = await ctx.nodes.getWithoutEmbedding([...EMBEDDABLE_TYPES], BATCH_SIZE);
    if (pending.length === 0) continue;

    const texts: string[] = [];
    const nodeIds: string[] = [];

    for (const node of pending) {
      const text = getEmbeddingText(node);
      if (text) {
        texts.push(text);
        nodeIds.push(node.id);
      } else {
        roundSkipped++;
      }
    }

    if (texts.length === 0) continue;

    try {
      const embeddings = await generateEmbeddings(texts);
      for (let i = 0; i < nodeIds.length; i++) {
        await ctx.nodes.updateEmbedding(nodeIds[i], embeddings[i]);
      }
      roundGenerated += nodeIds.length;
      console.log(`[embed-sync] Generated ${nodeIds.length} embeddings for project "${project.slug}"`);
    } catch (err) {
      stats.totalErrors++;
      console.error(`[embed-sync] Error for project "${project.slug}":`, err);
    }
  }

  stats.totalGenerated += roundGenerated;
  stats.totalSkipped += roundSkipped;
  stats.lastRunAt = new Date().toISOString();

  if (roundGenerated > 0) {
    stats.consecutiveIdle = 0;
  } else {
    stats.consecutiveIdle++;
    // Log idle status every 10 minutes (20 cycles) to avoid spam
    if (stats.consecutiveIdle === 1 || stats.consecutiveIdle % 20 === 0) {
      console.log(`[embed-sync] Idle (total generated: ${stats.totalGenerated}, errors: ${stats.totalErrors})`);
    }
  }
}

export function startEmbedSync(manager: ProjectManager): void {
  if (!getEmbeddingConfig()) {
    console.log('[embed-sync] EMBEDDING_API_KEY not set, skipping embedding sync');
    return;
  }

  console.log('[embed-sync] Started (interval: 30s)');

  // Run once immediately
  syncOnce(manager).catch(err => console.error('[embed-sync] Initial sync error:', err));

  timer = setInterval(() => {
    syncOnce(manager).catch(err => console.error('[embed-sync] Sync error:', err));
  }, INTERVAL_MS);
}

export function stopEmbedSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
