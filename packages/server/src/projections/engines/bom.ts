import type { OperationContext } from '@sibeaver/core';
import type { RequirementNode } from '@sibeaver/core';
import type { ProjectionTemplate, GeneratedProjection, ProjectionConfigEntry } from '../types.js';

const SIBS_STATUS_TO_LABEL: Record<string, string> = {
  proposed: '待开始',
  accepted: '待开始',
  in_execution: '进行中',
  revision_needed: '进行中',
  satisfied: '已完成',
  deprecated: '已废弃',
};

const SIBS_PRIORITY_TO_LABEL: Record<string, string> = {
  critical: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

const STATUS_ICONS: Record<string, string> = {
  proposed: '⬜',
  accepted: '⬜',
  in_execution: '🔄',
  revision_needed: '⚠️',
  satisfied: '✅',
  deprecated: '🗑️',
};

function parseDomain(req: RequirementNode): string {
  if (req.source_detail) {
    const slashIdx = req.source_detail.indexOf('/');
    if (slashIdx > 0) return req.source_detail.slice(0, slashIdx);
  }
  return req.tags[0] ?? 'unknown';
}

function parseReqId(req: RequirementNode): string {
  if (req.source_detail) {
    const slashIdx = req.source_detail.indexOf('/');
    if (slashIdx > 0) return req.source_detail.slice(slashIdx + 1);
  }
  return req.id.slice(0, 8);
}

function acceptanceProgress(req: RequirementNode): string {
  if (!req.acceptance || req.acceptance.type !== 'checklist') return '—';
  const total = req.acceptance.items.length;
  const done = req.acceptance.items.filter(i => i.satisfied).length;
  return `${done}/${total}`;
}

function progressBar(done: number, total: number): string {
  if (total === 0) return '——';
  const pct = Math.round((done / total) * 100);
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}

export const bomProjection: ProjectionTemplate = {
  type: 'bom',
  label: 'BOM 需求清单',
  description: '从 sibs 需求节点生成 INDEX.md 格式的 BOM 投影，按域分组展示需求拓扑和进度',

  async generate(ctx: OperationContext, config: ProjectionConfigEntry): Promise<GeneratedProjection> {
    const allReqs = await ctx.nodes.getByType('requirement') as RequirementNode[];

    if (allReqs.length === 0) {
      return {
        markdown: '# BOM 需求清单\n\n暂无需求。\n',
        metadata: {
          title: 'BOM 需求清单',
          generatedAt: new Date().toISOString(),
          sourceNodeCount: 0,
          sourceNodeIds: [],
        },
      };
    }

    const sourceNodeIds = allReqs.map(r => r.id);

    // Group by domain
    const domainMap = new Map<string, RequirementNode[]>();
    for (const req of allReqs) {
      const domain = parseDomain(req);
      if (!domainMap.has(domain)) domainMap.set(domain, []);
      domainMap.get(domain)!.push(req);
    }

    // Apply domain filter
    const filterDomain = config.filters?.domain;
    const domains = filterDomain
      ? [[filterDomain, domainMap.get(filterDomain) ?? []] as const]
      : Array.from(domainMap.entries());

    const sections: string[] = [];

    if (filterDomain) {
      // Single domain INDEX.md
      const [domainId, reqs] = domains[0];
      sections.push(`# ${domainId} BOM\n`);
      sections.push(`> 生成时间: ${new Date().toISOString().slice(0, 19)}  |  需求总数: ${reqs.length}\n`);

      sections.push(formatDomainTable(reqs));
      const done = reqs.filter(r => r.status === 'satisfied').length;
      sections.push(`\n## 进度\n\n${progressBar(done, reqs.length)} (${done}/${reqs.length} 已完成)\n`);
    } else {
      // Root INDEX.md — all domains
      sections.push('# BOM 需求清单\n');
      sections.push(`> 生成时间: ${new Date().toISOString().slice(0, 19)}  |  需求总数: ${allReqs.length}\n`);

      // Domain progress table
      sections.push('## 域进度\n');
      sections.push('| 域 | 已完成 | 总数 | 进度 |');
      sections.push('|------|--------|------|------|');

      let totalDone = 0;
      for (const [domainId, reqs] of domains) {
        const done = reqs.filter(r => r.status === 'satisfied').length;
        totalDone += done;
        const pct = reqs.length > 0 ? Math.round((done / reqs.length) * 100) : 0;
        sections.push(`| ${domainId} | ${done} | ${reqs.length} | ${pct}% |`);
      }
      const globalPct = allReqs.length > 0 ? Math.round((totalDone / allReqs.length) * 100) : 0;
      sections.push(`| **TOTAL** | **${totalDone}** | **${allReqs.length}** | **${globalPct}%** |`);
      sections.push('');

      // Per-domain requirement tables
      for (const [domainId, reqs] of domains) {
        const done = reqs.filter(r => r.status === 'satisfied').length;
        sections.push(`## ${domainId} (${done}/${reqs.length})\n`);
        sections.push(formatDomainTable(reqs));
        sections.push('');
      }

      sections.push(`## 总进度\n\n${progressBar(totalDone, allReqs.length)} (${totalDone}/${allReqs.length} 已完成)\n`);
    }

    return {
      markdown: sections.join('\n'),
      metadata: {
        title: 'BOM 需求清单',
        generatedAt: new Date().toISOString(),
        sourceNodeCount: allReqs.length,
        sourceNodeIds,
      },
    };
  },
};

function formatDomainTable(reqs: RequirementNode[]): string {
  const lines: string[] = [];
  lines.push('| ID | 名称 | 状态 | 优先级 | 验收 |');
  lines.push('|------|------|------|--------|------|');

  const sorted = [...reqs].sort((a, b) => {
    const order = ['critical', 'high', 'medium', 'low'];
    const pa = order.indexOf(a.priority);
    const pb = order.indexOf(b.priority);
    if (pa !== pb) return pa - pb;
    return a.created_at.localeCompare(b.created_at);
  });

  for (const req of sorted) {
    const id = parseReqId(req);
    const statusLabel = SIBS_STATUS_TO_LABEL[req.status] ?? req.status;
    const priorityLabel = SIBS_PRIORITY_TO_LABEL[req.priority] ?? req.priority;
    const icon = STATUS_ICONS[req.status] ?? '';
    const acc = acceptanceProgress(req);
    lines.push(`| ${id} | ${req.title} | ${icon} ${statusLabel} | ${priorityLabel} | ${acc} |`);
  }

  return lines.join('\n');
}
