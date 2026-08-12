import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { Edge } from '../edges/types.js';
import { isValidTransition, RISK_TRANSITIONS, TECH_DEBT_TRANSITIONS } from '../lifecycle/machines.js';
import type { RiskNode, TechDebtNode } from '../nodes/types.js';
import { validateRelation } from '../edges/types.js';
import type { NodeType } from '../nodes/types.js';

// ============================================================
// identify_risk — 识别风险
// ============================================================

export interface IdentifyRiskInput {
  title: string;
  description: string;
  likelihood: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high' | 'critical';
  trigger_conditions?: string[];
  affected_witems?: string[];
  mitigation_strategy?: string;
  tags?: string[];
}

export async function identifyRisk(ctx: OperationContext, input: IdentifyRiskInput) {
  return ctx.withTx(async (tx) => {
    const now = new Date().toISOString();
    const risk: RiskNode = {
      id: ulid(),
      type: 'risk',
      title: input.title,
      description: input.description,
      status: 'identified',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      metadata: {},
      likelihood: input.likelihood,
      impact: input.impact,
      mitigation_strategy: input.mitigation_strategy ?? null,
      trigger_conditions: input.trigger_conditions ?? [],
    };

    await tx.nodes.insert(risk);
    const edges_created: Edge[] = [];

    for (const witemId of input.affected_witems ?? []) {
      const edge: Edge = {
        id: ulid(), source_id: risk.id, target_id: witemId,
        relation: 'blocks', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'risk.identified',
      operation: 'identify_risk',
      node_id: risk.id,
      node_type: 'risk',
      payload: { title: input.title, likelihood: input.likelihood, impact: input.impact },
    });

    return { risk, edges_created, event };
  });
}

// ============================================================
// update_risk — 更新风险
// ============================================================

export interface UpdateRiskInput {
  risk_id: string;
  new_status?: 'identified' | 'analyzing' | 'mitigated' | 'accepted' | 'occurred' | 'resolved';
  likelihood?: 'low' | 'medium' | 'high';
  impact?: 'low' | 'medium' | 'high' | 'critical';
  mitigation_strategy?: string;
  reason: string;
}

export async function updateRisk(ctx: OperationContext, input: UpdateRiskInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.risk_id);
    if (!node || node.type !== 'risk') {
      throw new Error(`风险不存在：${input.risk_id}`);
    }

    const risk = node as RiskNode;
    const diffs: any[] = [];

    if (input.new_status && input.new_status !== risk.status) {
      if (!isValidTransition(RISK_TRANSITIONS, risk.status, input.new_status)) {
        throw new Error(`无效状态迁移：${risk.status} → ${input.new_status}`);
      }
      diffs.push({ field: 'status', old_value: risk.status, new_value: input.new_status });
    }

    const updated: RiskNode = {
      ...risk,
      status: input.new_status ?? risk.status,
      likelihood: input.likelihood ?? risk.likelihood,
      impact: input.impact ?? risk.impact,
      mitigation_strategy: input.mitigation_strategy ?? risk.mitigation_strategy,
      updated_at: new Date().toISOString(),
    };
    await tx.nodes.update(updated);

    const event = await tx.events.emit({
      event_type: 'risk.updated',
      operation: 'update_risk',
      node_id: input.risk_id,
      node_type: 'risk',
      payload: { reason: input.reason },
      diff: diffs.length > 0 ? diffs : null,
      context: input.reason,
    });

    return { risk: updated, event };
  });
}

// ============================================================
// register_tech_debt — 注册技术债
// ============================================================

export interface RegisterTechDebtInput {
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affected_area: string;
  cost_of_delay: string;
  resolution_approach?: string;
  caused_by?: string;
  blocks?: string[];
  tags?: string[];
}

export async function registerTechDebt(ctx: OperationContext, input: RegisterTechDebtInput) {
  return ctx.withTx(async (tx) => {
    const now = new Date().toISOString();
    const techDebt: TechDebtNode = {
      id: ulid(),
      type: 'tech_debt',
      title: input.title,
      description: input.description,
      status: 'identified',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      metadata: {},
      severity: input.severity,
      affected_area: input.affected_area,
      cost_of_delay: input.cost_of_delay,
      resolution_approach: input.resolution_approach ?? null,
    };

    await tx.nodes.insert(techDebt);
    const edges_created: Edge[] = [];

    if (input.caused_by) {
      const cause = await tx.nodes.getById(input.caused_by);
      if (!cause || !validateRelation('creates', cause.type as NodeType, 'tech_debt')) {
        throw new Error(`来源决策不存在或类型不符：${input.caused_by}`);
      }
      const edge: Edge = {
        id: ulid(), source_id: input.caused_by, target_id: techDebt.id,
        relation: 'creates', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    for (const blockId of input.blocks ?? []) {
      const edge: Edge = {
        id: ulid(), source_id: techDebt.id, target_id: blockId,
        relation: 'blocks', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'tech_debt.registered',
      operation: 'register_tech_debt',
      node_id: techDebt.id,
      node_type: 'tech_debt',
      payload: { title: input.title, severity: input.severity, affected_area: input.affected_area },
    });

    return { tech_debt: techDebt, edges_created, event };
  });
}
