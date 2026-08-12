// @sibom r-m3v9
import type { OperationContext } from '@sibeaver/core';
import type { ExplorationNode } from '@sibeaver/core';
import type {
  ProjectionTemplate,
  GeneratedProjection,
  ProjectionConfigEntry,
} from '../types.js';

// ── helpers ──────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  proposed: '待启动',
  active: '进行中',
  concluded: '已结论',
  abandoned: '已放弃',
};

const OUTCOME_LABEL: Record<string, string> = {
  validated: '假设验证通过',
  invalidated: '假设被推翻',
  partial: '部分验证',
  inconclusive: '无定论',
};

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    proposed: '○',
    active: '◐',
    concluded: '✓',
    abandoned: '✗',
  };
  return map[status] ?? status;
}

// ── filters ──────────────────────────────────────────────────────────

function filterExplorations(
  items: ExplorationNode[],
  filters: ProjectionConfigEntry['filters'],
): ExplorationNode[] {
  const statuses = filters?.status;
  const tags = filters?.tags;

  if (!statuses?.length && !tags?.length) return items;

  return items.filter(e => {
    if (statuses?.length && !statuses.includes(e.status)) return false;
    if (tags?.length && !tags.some(t => e.tags.includes(t))) return false;
    return true;
  });
}

// ── formatter ────────────────────────────────────────────────────────

function formatExploration(e: ExplorationNode, index: number): string {
  const lines: string[] = [];
  const num = String(index + 1).padStart(4, '0');

  lines.push(`### EXP-${num}: ${e.title}\n`);
  lines.push(`| 字段 | 值 |`);
  lines.push(`|------|----|`);
  lines.push(`| 状态 | ${statusEmoji(e.status)} ${STATUS_LABEL[e.status] ?? e.status} |`);
  lines.push(`| 日期 | ${e.created_at.slice(0, 10)} |`);
  if (e.tags.length > 0) lines.push(`| 标签 | ${e.tags.join(', ')} |`);
  lines.push(`| Node ID | \`${e.id}\` |`);
  lines.push('');

  if (e.hypothesis) {
    lines.push(`### 假设\n\n${e.hypothesis}\n`);
  }

  if (e.approach) {
    lines.push(`### 方法\n\n${e.approach}\n`);
  }

  if (e.findings.length > 0) {
    lines.push('### 发现\n');
    for (const f of e.findings) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (e.outcome && e.conclusion) {
    lines.push(`### 结论: ${OUTCOME_LABEL[e.outcome] ?? e.outcome}\n`);
    lines.push(`${e.conclusion}\n`);
  } else if (e.conclusion) {
    lines.push('### 结论\n');
    lines.push(`${e.conclusion}\n`);
  }

  if (e.description) {
    lines.push(`---\n\n*${e.description}*\n`);
  }

  if (e.status === 'active') {
    lines.push('');
    lines.push('> 此项探索尚在进行中。结论将在完成后产生。\n');
  }

  return lines.join('\n');
}

// ── engine ───────────────────────────────────────────────────────────

export const explorationProjection: ProjectionTemplate = {
  type: 'exploration',
  label: 'Knowledge Explorations',
  description: 'Generate exploration knowledge documents (hypothesis → findings → conclusion)',

  async generate(
    ctx: OperationContext,
    config: ProjectionConfigEntry,
  ): Promise<GeneratedProjection> {
    const allExplorations = (await ctx.nodes.getByType('exploration')) as ExplorationNode[];

    const filtered = filterExplorations(allExplorations, config.filters);

    // sort: concluded first, then active, proposed, abandoned; within group by date
    const statusOrder: Record<string, number> = { concluded: 0, active: 1, proposed: 2, abandoned: 3 };
    filtered.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 4;
      const sb = statusOrder[b.status] ?? 4;
      if (sa !== sb) return sa - sb;
      return a.created_at.localeCompare(b.created_at);
    });

    const parts: string[] = [];
    const now = new Date().toISOString();

    parts.push('# 探索知识文档 (Knowledge Explorations)\n');
    parts.push(`> 生成时间: ${now.slice(0, 19)}Z\n`);
    parts.push(`> 数据来源: ${filtered.length} 个探索节点\n`);
    parts.push('> 探索记录假设、验证方法和结论，是决策和知识的前置过程。\n\n');

    if (filtered.length === 0) {
      parts.push('_当前没有匹配筛选条件的探索记录。_\n');
      return {
        markdown: parts.join(''),
        metadata: { title: '探索知识文档', generatedAt: now, sourceNodeCount: 0, sourceNodeIds: [] },
      };
    }

    // stats summary
    const statusCounts: Record<string, number> = {};
    for (const e of filtered) {
      statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
    }
    parts.push('| 状态 | 数量 |');
    parts.push('|------|------|');
    for (const [s, c] of Object.entries(statusCounts)) {
      parts.push(`| ${STATUS_LABEL[s] ?? s} | ${c} |`);
    }
    parts.push('');

    // render by status group
    const sections: Record<string, ExplorationNode[]> = {};
    for (const e of filtered) {
      (sections[e.status] ??= []).push(e);
    }

    let globalIndex = 0;
    for (const status of ['concluded', 'active', 'proposed', 'abandoned'] as const) {
      const group = sections[status];
      if (!group || group.length === 0) continue;

      parts.push(`## ${statusEmoji(status)} ${STATUS_LABEL[status]}\n`);

      for (const e of group) {
        parts.push(formatExploration(e, globalIndex));
        globalIndex++;
        if (globalIndex < filtered.length) {
          parts.push('\n---\n\n');
        }
      }
    }

    return {
      markdown: parts.join(''),
      metadata: {
        title: '探索知识文档',
        generatedAt: now,
        sourceNodeCount: filtered.length,
        sourceNodeIds: filtered.map(e => e.id),
      },
    };
  },
};
