// @sibom r-b8fp
import type { OperationContext } from '@sibeaver/core';
import type { DecisionNode } from '@sibeaver/core';
import type { ProjectionTemplate, GeneratedProjection, ProjectionConfigEntry } from '../types.js';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatAdr(decision: DecisionNode, index: number): string {
  const shortId = decision.id.slice(0, 8);

  let md = `# ADR-${String(index + 1).padStart(4, '0')}: ${decision.title}\n\n`;

  md += `| Field | Value |\n`;
  md += `|-------|-------|\n`;
  md += `| Status | ${decision.status} |\n`;
  md += `| Date | ${decision.created_at.slice(0, 10)} |\n`;
  if (decision.tags.length > 0) {
    md += `| Tags | ${decision.tags.join(', ')} |\n`;
  }
  md += `| Node ID | \`${decision.id}\` |\n\n`;

  md += `## Context\n\n${decision.context}\n\n`;
  md += `## Decision\n\n${decision.rationale}\n\n`;

  if (decision.consequences.length > 0) {
    md += `## Consequences\n\n${decision.consequences.map(c => `- ${c}`).join('\n')}\n\n`;
  }

  if (decision.alternatives_considered.length > 0) {
    md += `## Alternatives Considered\n\n`;
    for (const alt of decision.alternatives_considered) {
      md += `### ${alt.option}\n\n`;
      if (alt.pros.length > 0) {
        md += `**Pros:**\n${alt.pros.map(p => `- ${p}`).join('\n')}\n\n`;
      }
      if (alt.cons.length > 0) {
        md += `**Cons:**\n${alt.cons.map(c => `- ${c}`).join('\n')}\n\n`;
      }
      md += `**Reason rejected:** ${alt.reason_rejected}\n\n`;
    }
  }

  if (decision.description) {
    md += `---\n\n*${decision.description}*\n`;
  }

  return md;
}

export const adrProjection: ProjectionTemplate = {
  type: 'adr',
  label: 'Architecture Decision Records',
  description: 'Generate ADR documents from Decision nodes',

  async generate(ctx: OperationContext, config: ProjectionConfigEntry): Promise<GeneratedProjection> {
    const allDecisions = (await ctx.nodes.getByType('decision')) as DecisionNode[];

    const statusFilter = config.filters?.status;
    const tagFilter = config.filters?.tags;

    const filtered = allDecisions.filter(d => {
      if (statusFilter && statusFilter.length > 0 && !statusFilter.includes(d.status)) return false;
      if (tagFilter && tagFilter.length > 0 && !tagFilter.some(t => d.tags.includes(t))) return false;
      return true;
    });

    filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const parts: string[] = [];
    parts.push(`# Architecture Decision Records\n`);
    parts.push(`> Generated: ${new Date().toISOString().slice(0, 19)}Z\n`);
    parts.push(`> Source: ${filtered.length} decision node(s) from sibeaver semantic graph\n\n`);

    if (filtered.length === 0) {
      parts.push(`_No decisions match the configured filters._\n`);
    }

    for (let i = 0; i < filtered.length; i++) {
      parts.push(formatAdr(filtered[i], i));
      if (i < filtered.length - 1) {
        parts.push('\n---\n\n');
      }
    }

    return {
      markdown: parts.join(''),
      metadata: {
        title: 'Architecture Decision Records',
        generatedAt: new Date().toISOString(),
        sourceNodeCount: filtered.length,
        sourceNodeIds: filtered.map(d => d.id),
      },
    };
  },
};
