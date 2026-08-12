import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { DecisionNode } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';
import { isValidTransition, DECISION_TRANSITIONS } from '../lifecycle/machines.js';

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
  related_witems?: string[];
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
  return ctx.withTx(async (tx) => {
    // 统一图谱锚点必填：写入即锚定，从 ROOT 可达为结构存活判据
    const hasAnchor = (input.related_witems?.length ?? 0) > 0 || !!input.supersedes;
    if (!hasAnchor) {
      throw new Error('决策必须关联工作项（related_witems）或取代旧决策（supersedes）——写入即锚定，悬空节点不被回收');
    }

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

    await tx.nodes.insert(decision);
    const edges_created: Edge[] = [];
    const risks_created: any[] = [];
    const tech_debt_created: any[] = [];

    // 关联工作项
    for (const witemId of input.related_witems ?? []) {
      const edge: Edge = {
        id: ulid(), source_id: decision.id, target_id: witemId,
        relation: 'relates_to', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    // 取代旧决策
    if (input.supersedes) {
      const oldDecision = await tx.nodes.getById(input.supersedes);
      if (oldDecision && oldDecision.type === 'decision') {
        const updated = {
          ...oldDecision as DecisionNode,
          status: 'superseded' as const,
          superseded_by: decision.id,
          updated_at: now,
        };
        await tx.nodes.update(updated);

        const edge: Edge = {
          id: ulid(), source_id: decision.id, target_id: input.supersedes,
          relation: 'supersedes', weight: null, annotation: null, created_at: now,
        };
        await tx.edges.insert(edge);
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
      await tx.nodes.insert(risk);
      risks_created.push(risk);

      const edge: Edge = {
        id: ulid(), source_id: decision.id, target_id: risk.id,
        relation: 'creates', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
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
      await tx.nodes.insert(techDebt);
      tech_debt_created.push(techDebt);

      const edge: Edge = {
        id: ulid(), source_id: decision.id, target_id: techDebt.id,
        relation: 'creates', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
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
  });
}

// ============================================================
// update_decision_status — 决策生命周期兑现度回写
// ============================================================

export interface UpdateDecisionStatusInput {
  decision_id: string;
  new_status: 'accepted' | 'superseded' | 'deprecated' | 'failed';
  reason: string;
}

export async function updateDecisionStatus(ctx: OperationContext, input: UpdateDecisionStatusInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.decision_id);
    if (!node || node.type !== 'decision') {
      throw new Error(`决策不存在：${input.decision_id}`);
    }

    const oldStatus = node.status;
    if (!isValidTransition(DECISION_TRANSITIONS, oldStatus as any, input.new_status)) {
      throw new Error(`无效状态迁移：${oldStatus} → ${input.new_status}`);
    }

    const updated: DecisionNode = {
      ...node as DecisionNode,
      status: input.new_status,
      updated_at: new Date().toISOString(),
    };
    await tx.nodes.update(updated);

    const event = await tx.events.emit({
      event_type: 'decision.superseded',
      operation: 'update_decision_status',
      node_id: input.decision_id,
      node_type: 'decision',
      payload: { reason: input.reason },
      diff: [{ field: 'status', old_value: oldStatus, new_value: input.new_status }],
      context: input.reason,
    });

    return { decision: updated, event };
  });
}
