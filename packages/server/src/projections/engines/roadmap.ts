import type { OperationContext } from '@sibeaver/core';
import type {
  GoalNode,
  ExplorationNode,
  RiskNode,
  TechDebtNode,
  CognitiveNode,
} from '@sibeaver/core';
import { getRoadmap, currentBlockers } from '@sibeaver/core';
import type { RoadmapItem } from '@sibeaver/core';
import type {
  ProjectionTemplate,
  GeneratedProjection,
  ProjectionConfigEntry,
} from '../types.js';

// ── helpers ──────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const HORIZON_LABEL: Record<string, string> = {
  short: '短期目标（当前迭代）',
  medium: '中期目标（本季度）',
  long: '长期目标（愿景）',
};

function formatProgress(done: number, total: number): string {
  if (total === 0) return 'N/A';
  const pct = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${bar} ${done}/${total} (${pct}%)`;
}

function priorityBadge(p: string | undefined): string {
  if (!p) return '';
  const map: Record<string, string> = {
    critical: '[!!! CRITICAL]',
    high: '[!! HIGH]',
    medium: '[! MEDIUM]',
    low: '[LOW]',
  };
  return map[p] ?? `[${p.toUpperCase()}]`;
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    active: '▶',
    achieved: '✓',
    abandoned: '✗',
    deferred: '⏸',
    proposed: '○',
    concluded: '✓',
  };
  return map[status] ?? status;
}

// ── filters ──────────────────────────────────────────────────────────

function filterRoadmap(roadmap: RoadmapItem[], filters: ProjectionConfigEntry['filters']): RoadmapItem[] {
  const horizons = filters?.horizon;
  const statuses = filters?.status;
  const tags = filters?.tags;

  if (!horizons?.length && !statuses?.length && !tags?.length) return roadmap;

  return roadmap.filter(item => {
    const goal = item.node as GoalNode;
    if (horizons?.length && !horizons.includes(goal.horizon)) return false;
    if (statuses?.length && !statuses.includes(goal.status)) return false;
    if (tags?.length && !tags.some(t => goal.tags.includes(t))) return false;
    return true;
  });
}

// ── formatters ───────────────────────────────────────────────────────

function collectIds(item: RoadmapItem, set: Set<string>): void {
  set.add(item.node.id);
  for (const child of item.children) collectIds(child, set);
}

function formatGoal(item: RoadmapItem, depth: number): string {
  const goal = item.node as GoalNode;
  const lines: string[] = [];
  const heading = '###' + '#'.repeat(Math.min(depth, 2));

  lines.push(`${heading} ${priorityBadge(goal.priority)} ${goal.title}\n`);

  lines.push(`| 字段 | 值 |`);
  lines.push(`|------|----|`);
  lines.push(`| 状态 | ${statusEmoji(goal.status)} ${goal.status} |`);
  lines.push(`| 时间范围 | ${goal.horizon} |`);
  if (goal.description) lines.push(`| 描述 | ${goal.description} |`);
  if (goal.tags.length > 0) lines.push(`| 标签 | ${goal.tags.join(', ')} |`);
  lines.push(`| 进度 | ${formatProgress(item.progress.done, item.progress.total)} |`);
  lines.push('');

  if (goal.success_criteria.length > 0) {
    lines.push('**成功标准**:\n');
    for (const c of goal.success_criteria) lines.push(`- ${c}`);
    lines.push('');
  }

  // categorize children
  const subGoals = item.children.filter(c => c.node.type === 'goal');
  const explorations = item.children.filter(c => c.node.type === 'exploration');

  if (subGoals.length > 0) {
    lines.push('**子目标**:\n');
    for (const child of subGoals) {
      const sg = child.node as GoalNode;
      lines.push(`- ${priorityBadge(sg.priority)} **${sg.title}** — ${statusEmoji(sg.status)} ${sg.status} | ${formatProgress(child.progress.done, child.progress.total)}`);
    }
    lines.push('');
  }

  if (explorations.length > 0) {
    lines.push('**探索**:\n');
    for (const child of explorations) {
      const e = child.node as ExplorationNode;
      let line = `- **${e.title}** — ${statusEmoji(e.status)} ${e.status}`;
      if (e.hypothesis) line += ` | 假设: "${e.hypothesis}"`;
      if (e.conclusion) line += ` | 结论: ${e.outcome ?? '?'} — "${e.conclusion}"`;
      lines.push(line);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatBlockersSection(
  blockers: { blocker: CognitiveNode; blocks: CognitiveNode[] }[],
  goalIdsInScope: Set<string>,
): string {
  const relevant = blockers.filter(b =>
    b.blocks.some(blocked => goalIdsInScope.has(blocked.id)),
  );

  const lines: string[] = [];
  lines.push('## 当前阻塞项\n');

  if (relevant.length === 0) {
    lines.push('_当前没有阻塞项。_\n');
    return lines.join('\n');
  }

  for (const { blocker, blocks } of relevant) {
    lines.push(`### ${blocker.title}\n`);
    lines.push(`| 字段 | 值 |`);
    lines.push(`|------|----|`);

    if (blocker.type === 'risk') {
      const r = blocker as RiskNode;
      lines.push(`| 类型 | 风险 |`);
      lines.push(`| 状态 | ${r.status} |`);
      lines.push(`| 影响 | ${r.impact} |`);
      lines.push(`| 可能性 | ${r.likelihood} |`);
      if (r.mitigation_strategy) lines.push(`| 缓解措施 | ${r.mitigation_strategy} |`);
    } else {
      const td = blocker as TechDebtNode;
      lines.push(`| 类型 | 技术债 |`);
      lines.push(`| 严重程度 | ${td.severity} |`);
      lines.push(`| 影响范围 | ${td.affected_area} |`);
      if (td.resolution_approach) lines.push(`| 解决方案 | ${td.resolution_approach} |`);
    }

    lines.push('');
    lines.push('**阻塞**:\n');
    for (const blocked of blocks) {
      if (goalIdsInScope.has(blocked.id)) {
        lines.push(`- ${blocked.title} (${blocked.status})`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatReadingGuide(): string {
  return `## 新人阅读顺序建议

1. **先看整体**: 浏览所有目标的标题和状态，了解项目当前在做什么。
2. **按时间范围阅读**: 先看短期目标（当前迭代），再看中期目标（本季度），最后了解长期愿景。
3. **关注阻塞项**: 查看"当前阻塞项"章节，了解主要风险和障碍。
4. **深入细节**: 对感兴趣的目标，查看其成功标准、子任务和探索结论。
`;
}

// ── engine ───────────────────────────────────────────────────────────

export const roadmapProjection: ProjectionTemplate = {
  type: 'roadmap',
  label: 'Requirements Overview (Roadmap)',
  description: 'Generate a newcomer-friendly requirements overview from the Goal tree',

  async generate(
    ctx: OperationContext,
    config: ProjectionConfigEntry,
  ): Promise<GeneratedProjection> {
    const { roadmap } = await getRoadmap(ctx, { include_completed: true, max_depth: 3 });

    const filtered = filterRoadmap(roadmap, config.filters);

    // collect all IDs in scope for blockers correlation
    const goalIdsInScope = new Set<string>();
    for (const item of filtered) collectIds(item, goalIdsInScope);

    // group by horizon, sort by priority within each
    const byHorizon: Record<string, RoadmapItem[]> = { short: [], medium: [], long: [] };
    for (const item of filtered) {
      const h = (item.node as GoalNode).horizon;
      (byHorizon[h] ??= []).push(item);
    }
    for (const h of ['short', 'medium', 'long'] as const) {
      byHorizon[h].sort((a, b) => {
        const pa = PRIORITY_ORDER[(a.node as GoalNode).priority] ?? 2;
        const pb = PRIORITY_ORDER[(b.node as GoalNode).priority] ?? 2;
        return pa - pb;
      });
    }

    // fetch blockers
    const { blockers } = await currentBlockers(ctx);

    const parts: string[] = [];
    const now = new Date().toISOString();

    parts.push('# 需求总览 (Requirements Overview)\n');
    parts.push(`> 生成时间: ${now.slice(0, 19)}Z\n`);
    parts.push(`> 数据来源: ${filtered.length} 个顶层目标\n`);
    parts.push(`> 可用于新人入职、干系人对齐和项目复盘\n\n`);

    if (filtered.length === 0) {
      parts.push('_当前没有匹配筛选条件的目标。_\n');
      return {
        markdown: parts.join(''),
        metadata: { title: '需求总览', generatedAt: now, sourceNodeCount: 0, sourceNodeIds: [] },
      };
    }

    for (const h of ['short', 'medium', 'long'] as const) {
      const items = byHorizon[h];
      if (items.length === 0) continue;
      parts.push(`## ${HORIZON_LABEL[h]}\n\n`);
      for (let i = 0; i < items.length; i++) {
        parts.push(formatGoal(items[i], 0));
        if (i < items.length - 1) parts.push('---\n\n');
      }
    }

    parts.push('\n');
    parts.push(formatBlockersSection(blockers, goalIdsInScope));

    parts.push('\n');
    parts.push(formatReadingGuide());

    // collect source node IDs
    const allIds: string[] = [];
    for (const item of filtered) {
      const stack = [item];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        allIds.push(cur.node.id);
        for (const c of cur.children) stack.push(c);
      }
    }

    return {
      markdown: parts.join(''),
      metadata: {
        title: '需求总览',
        generatedAt: now,
        sourceNodeCount: allIds.length,
        sourceNodeIds: allIds,
      },
    };
  },
};
