import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { DecisionNode } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';

// ============================================================
// record_decision — 记录决策
// ============================================================

export interface RecordDecisionInput {
  title: string;
  context: string;
  rationale: string;
  alternatives_considered?: {
    option: string;
    pros?: string[];
    cons?: string[];
    reason_rejected: string;
  }[];
  consequences?: string[];
  related_goals?: string[];
  related_explorations?: string[];
  supersedes?: string;
  risks_created?: {
    title: string;
    description: string;
    likelihood: 'low' | 'medium' | 'high';
    impact: 'low' | 'medium' | 'high' | 'critical';
  }[];
  tech_debt_created?: {
    title: string;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    affected_area: string;
    cost_of_delay: string;
  }[];
  tags?: string[];
}

export async function recordDecision(ctx: OperationContext, input: RecordDecisionInput) {
  const now = new Date().toISOString();

  const decision: DecisionNode = {
    id: ulid(),
    type: 'decision',
    title: input.title,
    description: '',
    status: 'accepted',
    tags: input.tags ?? [],
    created_at: now,
    updated_at: now,
    metadata: {},
    context: input.context,
    rationale: input.rationale,
    alternatives_considered: (input.alternatives_considered ?? []).map(a => ({
      option: a.option,
      pros: a.pros ?? [],
      cons: a.cons ?? [],
      reason_rejected: a.reason_rejected,
    })),
    consequences: input.consequences ?? [],
    superseded_by: null,
  };

  await ctx.nodes.insert(decision);
  const edges_created: Edge[] = [];
  const risks_created: any[] = [];
  const tech_debt_created: any[] = [];

  // 关联目标
  for (const goalId of input.related_goals ?? []) {
    const edge: Edge = {
      id: ulid(), source_id: decision.id, target_id: goalId,
      relation: 'relates_to', weight: null, annotation: null, created_at: now,
    };
    await ctx.edges.insert(edge);
    edges_created.push(edge);
  }

  // 关联探索
  for (const expId of input.related_explorations ?? []) {
    const edge: Edge = {
      id: ulid(), source_id: expId, target_id: decision.id,
      relation: 'produces', weight: null, annotation: null, created_at: now,
    };
    await ctx.edges.insert(edge);
    edges_created.push(edge);
  }

  // 取代旧决策
  if (input.supersedes) {
    const oldDecision = await ctx.nodes.getById(input.supersedes);
    if (oldDecision && oldDecision.type === 'decision') {
      const updated = {
        ...oldDecision as DecisionNode,
        status: 'superseded' as const,
        superseded_by: decision.id,
        updated_at: now,
      };
      await ctx.nodes.update(updated);

      const edge: Edge = {
        id: ulid(), source_id: decision.id, target_id: input.supersedes,
        relation: 'supersedes', weight: null, annotation: null, created_at: now,
      };
      await ctx.edges.insert(edge);
      edges_created.push(edge);
    }
  }

  // 创建风险
  for (const r of input.risks_created ?? []) {
    const risk = {
      id: ulid(), type: 'risk' as const, title: r.title,
      description: r.description, status: 'identified' as const,
      tags: [], created_at: now, updated_at: now, metadata: {},
      likelihood: r.likelihood, impact: r.impact,
      mitigation_strategy: null, trigger_conditions: [],
    };
    await ctx.nodes.insert(risk);
    risks_created.push(risk);

    const edge: Edge = {
      id: ulid(), source_id: decision.id, target_id: risk.id,
      relation: 'creates', weight: null, annotation: null, created_at: now,
    };
    await ctx.edges.insert(edge);
    edges_created.push(edge);
  }

  // 创建技术债
  for (const td of input.tech_debt_created ?? []) {
    const techDebt = {
      id: ulid(), type: 'tech_debt' as const, title: td.title,
      description: td.description, status: 'identified' as const,
      tags: [], created_at: now, updated_at: now, metadata: {},
      severity: td.severity, affected_area: td.affected_area,
      cost_of_delay: td.cost_of_delay, resolution_approach: null,
    };
    await ctx.nodes.insert(techDebt);
    tech_debt_created.push(techDebt);

    const edge: Edge = {
      id: ulid(), source_id: decision.id, target_id: techDebt.id,
      relation: 'creates', weight: null, annotation: null, created_at: now,
    };
    await ctx.edges.insert(edge);
    edges_created.push(edge);
  }

  const event = await ctx.events.emit({
    event_type: 'decision.recorded',
    operation: 'record_decision',
    node_id: decision.id,
    node_type: 'decision',
    payload: {
      title: input.title,
      supersedes: input.supersedes ?? null,
      risks_created: risks_created.length,
      tech_debt_created: tech_debt_created.length,
    },
  });

  return { decision, risks_created, tech_debt_created, edges_created, event };
}
