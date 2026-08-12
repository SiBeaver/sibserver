import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { GoalNode } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';
import type { EventRecord } from '../events/types.js';
import { isValidTransition, GOAL_TRANSITIONS } from '../lifecycle/machines.js';

// ============================================================
// define_goal — 定义目标
// ============================================================

export interface DefineGoalInput {
  title: string;
  description?: string;
  horizon: 'short' | 'medium' | 'long';
  success_criteria?: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
  parent_goal?: string;
  tags?: string[];
}

export interface DefineGoalResult {
  goal: GoalNode;
  edges_created: Edge[];
  event: EventRecord;
}

export async function defineGoal(ctx: OperationContext, input: DefineGoalInput): Promise<DefineGoalResult> {
  return ctx.withTx(async (tx) => {
    if (input.parent_goal) {
      const parent = await tx.nodes.getById(input.parent_goal);
      if (!parent || parent.type !== 'goal') {
        throw new Error(`父目标不存在：${input.parent_goal}`);
      }
    }

    const now = new Date().toISOString();
    const goal: GoalNode = {
      id: ulid(),
      type: 'goal',
      title: input.title,
      description: input.description ?? '',
      status: 'active',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      metadata: {},
      horizon: input.horizon,
      success_criteria: input.success_criteria ?? [],
      priority: input.priority,
    };

    await tx.nodes.insert(goal);

    const edges_created: Edge[] = [];

    if (input.parent_goal) {
      const edge: Edge = {
        id: ulid(),
        source_id: input.parent_goal,
        target_id: goal.id,
        relation: 'decomposes_into',
        weight: null,
        annotation: null,
        created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'goal.defined',
      operation: 'define_goal',
      node_id: goal.id,
      node_type: 'goal',
      payload: { ...input },
      context: null,
    });

    return { goal, edges_created, event };
  });
}

// ============================================================
// decompose_goal — 分解目标
// ============================================================

export interface DecomposeGoalInput {
  goal_id: string;
  sub_goals?: {
    title: string;
    description?: string;
    horizon: 'short' | 'medium' | 'long';
    success_criteria?: string[];
    priority?: 'critical' | 'high' | 'medium' | 'low';
  }[];
  explorations_needed?: {
    topic: string;
    reason: string;
    hypothesis?: string;
  }[];
}

export async function decomposeGoal(ctx: OperationContext, input: DecomposeGoalInput) {
  return ctx.withTx(async (tx) => {
    const now = new Date().toISOString();
    const parent = await tx.nodes.getById(input.goal_id);
    if (!parent || parent.type !== 'goal') {
      throw new Error(`目标不存在：${input.goal_id}`);
    }

    const sub_goals_created: GoalNode[] = [];
    const explorations_created: any[] = [];
    const edges_created: Edge[] = [];

    // 创建子目标
    for (const sg of input.sub_goals ?? []) {
      const node: GoalNode = {
        id: ulid(), type: 'goal', title: sg.title,
        description: sg.description ?? '', status: 'active',
        tags: [], created_at: now, updated_at: now, metadata: {},
        horizon: sg.horizon, success_criteria: sg.success_criteria ?? [],
        priority: sg.priority ?? 'medium',
      };
      await tx.nodes.insert(node);
      sub_goals_created.push(node);

      const edge: Edge = {
        id: ulid(), source_id: input.goal_id, target_id: node.id,
        relation: 'decomposes_into', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    // 创建探索
    for (const e of input.explorations_needed ?? []) {
      const node = {
        id: ulid(), type: 'exploration' as const, title: e.topic,
        description: e.reason, status: 'active' as const,
        tags: [], created_at: now, updated_at: now, metadata: {},
        hypothesis: e.hypothesis ?? '', approach: '',
        findings: [], conclusion: null, outcome: null,
      };
      await tx.nodes.insert(node);
      explorations_created.push(node);

      const edge: Edge = {
        id: ulid(), source_id: input.goal_id, target_id: node.id,
        relation: 'spawns', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'goal.decomposed',
      operation: 'decompose_goal',
      node_id: input.goal_id,
      node_type: 'goal',
      payload: {
        sub_goals: sub_goals_created.length,
        explorations: explorations_created.length,
      },
    });

    return { sub_goals_created, explorations_created, edges_created, event };
  });
}

// ============================================================
// update_goal_status — 更新目标状态
// ============================================================

export interface UpdateGoalStatusInput {
  goal_id: string;
  new_status: 'active' | 'achieved' | 'abandoned' | 'deferred';
  reason: string;
}

export async function updateGoalStatus(ctx: OperationContext, input: UpdateGoalStatusInput) {
  return ctx.withTx(async (tx) => {
    const goal = await tx.nodes.getById(input.goal_id);
    if (!goal || goal.type !== 'goal') {
      throw new Error(`目标不存在：${input.goal_id}`);
    }

    const oldStatus = goal.status;
    if (!isValidTransition(GOAL_TRANSITIONS, oldStatus as any, input.new_status)) {
      throw new Error(`无效状态迁移：${oldStatus} → ${input.new_status}`);
    }

    const updated: GoalNode = {
      ...goal as GoalNode,
      status: input.new_status,
      updated_at: new Date().toISOString(),
    };
    await tx.nodes.update(updated);

    const event = await tx.events.emit({
      event_type: 'goal.status_changed',
      operation: 'update_goal_status',
      node_id: input.goal_id,
      node_type: 'goal',
      payload: { reason: input.reason },
      diff: [{ field: 'status', old_value: oldStatus, new_value: input.new_status }],
      context: input.reason,
    });

    return { goal: updated, event };
  });
}
