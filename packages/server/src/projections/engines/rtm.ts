import type { OperationContext } from '@sibeaver/core';
import type { RequirementNode } from '@sibeaver/core';
import type { Edge } from '@sibeaver/core';
import type { ProjectionTemplate, GeneratedProjection, ProjectionConfigEntry } from '../types.js';

const STATUS_ICONS: Record<string, string> = {
  proposed: '📋',
  accepted: '✅',
  in_execution: '⚙️',
  revision_needed: '⚠️',
  satisfied: '🎉',
  deprecated: '🗑️',
};

const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];

export const rtmProjection: ProjectionTemplate = {
  type: 'rtm',
  label: '需求追溯矩阵',
  description: '生成需求追溯矩阵（RTM），展示每个需求的状态、验收标准完成度、执行链和自愈信号',

  async generate(ctx: OperationContext, config: ProjectionConfigEntry): Promise<GeneratedProjection> {
    const allRequirements = await ctx.nodes.getByType('requirement') as RequirementNode[];

    if (allRequirements.length === 0) {
      return {
        markdown: '# 需求追溯矩阵\n\n暂无需求。\n',
        metadata: {
          title: '需求追溯矩阵',
          generatedAt: new Date().toISOString(),
          sourceNodeCount: 0,
          sourceNodeIds: [],
        },
      };
    }

    let requirements = allRequirements;

    if (config.filters?.status?.length) {
      requirements = requirements.filter(r => config.filters!.status!.includes(r.status));
    }
    if (config.filters?.tags?.length) {
      requirements = requirements.filter(r =>
        config.filters!.tags!.some(t => r.tags.includes(t))
      );
    }

    requirements.sort((a, b) => {
      const pa = PRIORITY_ORDER.indexOf(a.priority);
      const pb = PRIORITY_ORDER.indexOf(b.priority);
      if (pa !== pb) return pa - pb;
      return a.created_at.localeCompare(b.created_at);
    });

    const sourceNodeIds: string[] = [];
    const sections: string[] = [];

    sections.push('# 需求追溯矩阵\n');
    sections.push(`> 生成时间: ${new Date().toISOString().slice(0, 19)}  |  需求总数: ${requirements.length}\n`);

    const stats = {
      proposed: 0, accepted: 0, in_execution: 0,
      revision_needed: 0, satisfied: 0, deprecated: 0,
    };
    for (const r of requirements) stats[r.status]++;

    sections.push('| 状态 | 数量 |');
    sections.push('|------|------|');
    for (const [status, count] of Object.entries(stats)) {
      if (count > 0) sections.push(`| ${STATUS_ICONS[status] || ''} ${status} | ${count} |`);
    }
    sections.push('');

    for (const req of requirements) {
      sourceNodeIds.push(req.id);
      const edges = await ctx.edges.getByNode(req.id);

      const fulfillEdges = edges.filter(e => e.relation === 'fulfills' && e.target_id === req.id);
      const contradictEdges = edges.filter(e => e.relation === 'contradicts' && e.target_id === req.id);
      const informsEdges = edges.filter(e => e.relation === 'informs' && e.source_id === req.id);

      const section = await formatRequirement(ctx, req, fulfillEdges, contradictEdges, informsEdges, sourceNodeIds);
      sections.push(section);
    }

    return {
      markdown: sections.join('\n'),
      metadata: {
        title: '需求追溯矩阵',
        generatedAt: new Date().toISOString(),
        sourceNodeCount: sourceNodeIds.length,
        sourceNodeIds,
      },
    };
  },
};

async function formatRequirement(
  ctx: OperationContext,
  req: RequirementNode,
  fulfillEdges: Edge[],
  contradictEdges: Edge[],
  informsEdges: Edge[],
  sourceNodeIds: string[],
): Promise<string> {
  const lines: string[] = [];
  const icon = STATUS_ICONS[req.status] || '';
  const shortId = req.id.slice(0, 8);

  lines.push(`## ${icon} ${req.title} [${req.status}] ${req.priority}`);
  lines.push(`来源: ${req.source}${req.source_detail ? ` (${req.source_detail})` : ''} | ID: \`${shortId}\`\n`);

  if (req.description) {
    lines.push(`> ${req.description}\n`);
  }

  // Acceptance
  if (req.acceptance?.type === 'checklist' && req.acceptance.items.length > 0) {
    const satisfied = req.acceptance.items.filter(i => i.satisfied).length;
    lines.push(`**验收标准** (${satisfied}/${req.acceptance.items.length} 已满足):\n`);
    for (const item of req.acceptance.items) {
      const check = item.satisfied ? 'x' : ' ';
      lines.push(`- [${check}] ${item.label}`);
    }
    lines.push('');
  }

  // Execution chain (fulfills edges)
  if (fulfillEdges.length > 0) {
    lines.push('**执行链**:\n');
    for (const edge of fulfillEdges) {
      const node = await ctx.nodes.getById(edge.source_id);
      if (node) {
        sourceNodeIds.push(node.id);
        const statusStr = 'status' in node ? ` [${(node as any).status}]` : '';
        lines.push(`- ${node.type}: ${node.title}${statusStr}`);
      }
    }
    lines.push('');
  }

  // Informs (requirement → goals)
  if (informsEdges.length > 0) {
    lines.push('**告知目标**:\n');
    for (const edge of informsEdges) {
      const node = await ctx.nodes.getById(edge.target_id);
      if (node) {
        sourceNodeIds.push(node.id);
        const statusStr = 'status' in node ? ` [${(node as any).status}]` : '';
        lines.push(`- ${node.type}: ${node.title}${statusStr}`);
      }
    }
    lines.push('');
  }

  // Self-heal signals (contradicts edges)
  if (contradictEdges.length > 0) {
    lines.push('**⚠️ 自愈信号**:\n');
    for (const edge of contradictEdges) {
      const knowledge = await ctx.nodes.getById(edge.source_id);
      if (knowledge) {
        sourceNodeIds.push(knowledge.id);
        const annotation = edge.annotation ? ` — ${edge.annotation}` : '';
        lines.push(`- ⚠️ Knowledge「${knowledge.title}」contradicts 此需求${annotation}`);
      }
    }
    lines.push('');
  }

  // No connections warning
  if (fulfillEdges.length === 0 && informsEdges.length === 0 && req.status !== 'proposed' && req.status !== 'deprecated') {
    lines.push('> ⚠️ 此需求无关联执行节点——悬空需求\n');
  }

  lines.push('---\n');
  return lines.join('\n');
}
