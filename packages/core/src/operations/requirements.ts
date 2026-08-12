import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { Edge } from '../edges/types.js';
import type { RequirementNode, Acceptance, RequirementStatus } from '../nodes/types.js';
import { isValidTransition, REQUIREMENT_TRANSITIONS } from '../lifecycle/machines.js';

// ============================================================
// define_requirement — 定义需求
// ============================================================

export interface DefineRequirementInput {
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  source: string;
  source_detail?: string;
  parent_goal?: string;
  tags?: string[];
  acceptance?: Acceptance;
  status?: RequirementStatus;
}

export async function defineRequirement(ctx: OperationContext, input: DefineRequirementInput) {
  return ctx.withTx(async (tx) => {
    if (input.parent_goal) {
      const goal = await tx.nodes.getById(input.parent_goal);
      if (!goal || goal.type !== 'goal') {
        throw new Error(`父目标不存在：${input.parent_goal}`);
      }
    }

    const now = new Date().toISOString();
    const requirement: RequirementNode = {
      id: ulid(),
      type: 'requirement',
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'proposed',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      metadata: {},
      priority: input.priority ?? 'medium',
      source: input.source,
      source_detail: input.source_detail ?? null,
      acceptance: input.acceptance ?? null,
    };

    await tx.nodes.insert(requirement);
    const edges_created: Edge[] = [];

    if (input.parent_goal) {
      const edge: Edge = {
        id: ulid(), source_id: requirement.id, target_id: input.parent_goal,
        relation: 'informs', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'requirement.defined',
      operation: 'define_requirement',
      node_id: requirement.id,
      node_type: 'requirement',
      payload: { title: input.title, priority: requirement.priority, source: input.source },
    });

    return { requirement, edges_created, event };
  });
}

// ============================================================
// update_requirement_status — 更新需求状态
// ============================================================

export interface UpdateRequirementStatusInput {
  requirement_id: string;
  new_status: 'proposed' | 'accepted' | 'in_execution' | 'revision_needed' | 'satisfied' | 'deprecated';
  reason: string;
  revision_suggestion?: string;
}

export async function updateRequirementStatus(ctx: OperationContext, input: UpdateRequirementStatusInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.requirement_id);
    if (!node || node.type !== 'requirement') {
      throw new Error(`需求不存在：${input.requirement_id}`);
    }

    const requirement = node as RequirementNode;
    const oldStatus = requirement.status;

    if (input.new_status === 'deprecated') {
      // deprecated can be reached from any non-terminal state
      if (oldStatus === 'satisfied' || oldStatus === 'deprecated') {
        throw new Error(`无效状态迁移：${oldStatus} → ${input.new_status}`);
      }
    } else {
      if (!isValidTransition(REQUIREMENT_TRANSITIONS, oldStatus, input.new_status)) {
        throw new Error(`无效状态迁移：${oldStatus} → ${input.new_status}`);
      }
    }

    const now = new Date().toISOString();
    const updated: RequirementNode = {
      ...requirement,
      status: input.new_status,
      updated_at: now,
    };
    await tx.nodes.update(updated);

    const eventType = input.new_status === 'revision_needed'
      ? 'requirement.revision_suggested' as const
      : 'requirement.status_changed' as const;

    const event = await tx.events.emit({
      event_type: eventType,
      operation: 'update_requirement_status',
      node_id: input.requirement_id,
      node_type: 'requirement',
      payload: {
        reason: input.reason,
        revision_suggestion: input.revision_suggestion ?? null,
      },
      diff: [{ field: 'status', old_value: oldStatus, new_value: input.new_status }],
      context: input.reason,
    });

    return { requirement: updated, event };
  });
}

// ============================================================
// update_requirement_acceptance — 更新需求验收标准
// ============================================================

export interface UpdateRequirementAcceptanceInput {
  requirement_id: string;
  acceptance: Acceptance;
}

export async function updateRequirementAcceptance(ctx: OperationContext, input: UpdateRequirementAcceptanceInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.requirement_id);
    if (!node || node.type !== 'requirement') {
      throw new Error(`需求不存在：${input.requirement_id}`);
    }

    const requirement = node as RequirementNode;
    const oldAcceptance = requirement.acceptance;
    const now = new Date().toISOString();
    const updated: RequirementNode = {
      ...requirement,
      acceptance: input.acceptance,
      updated_at: now,
    };
    await tx.nodes.update(updated);

    const event = await tx.events.emit({
      event_type: 'requirement.acceptance_updated',
      operation: 'update_requirement_acceptance',
      node_id: input.requirement_id,
      node_type: 'requirement',
      payload: { acceptance: input.acceptance },
      diff: [{ field: 'acceptance', old_value: oldAcceptance, new_value: input.acceptance }],
    });

    return { requirement: updated, event };
  });
}
