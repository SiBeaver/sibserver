import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { TaskNode } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';
import type { EventRecord } from '../events/types.js';
import { isValidTransition, TASK_TRANSITIONS } from '../lifecycle/machines.js';

// ============================================================
// create_task — 创建任务
// ============================================================

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  parent_goal?: string;
  tags?: string[];
}

export interface CreateTaskResult {
  task: TaskNode;
  edges_created: Edge[];
  event: EventRecord;
}

export async function createTask(ctx: OperationContext, input: CreateTaskInput): Promise<CreateTaskResult> {
  return ctx.withTx(async (tx) => {
    if (input.parent_goal) {
      const parent = await tx.nodes.getById(input.parent_goal);
      if (!parent || parent.type !== 'goal') {
        throw new Error(`父目标不存在：${input.parent_goal}`);
      }
    }

    const now = new Date().toISOString();
    const task: TaskNode = {
      id: ulid(),
      type: 'task',
      title: input.title,
      description: input.description ?? '',
      status: 'open',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      metadata: {},
      priority: input.priority ?? 'medium',
    };

    await tx.nodes.insert(task);

    const edges_created: Edge[] = [];

    if (input.parent_goal) {
      const edge: Edge = {
        id: ulid(),
        source_id: input.parent_goal,
        target_id: task.id,
        relation: 'decomposes_into',
        weight: null,
        annotation: null,
        created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'task.created',
      operation: 'create_task',
      node_id: task.id,
      node_type: 'task',
      payload: { ...input },
      context: null,
    });

    return { task, edges_created, event };
  });
}

// ============================================================
// update_task_status — 更新任务状态
// ============================================================

export interface UpdateTaskStatusInput {
  task_id: string;
  new_status: 'open' | 'in_progress' | 'done' | 'cancelled';
  reason?: string;
}

export async function updateTaskStatus(ctx: OperationContext, input: UpdateTaskStatusInput) {
  return ctx.withTx(async (tx) => {
    const task = await tx.nodes.getById(input.task_id);
    if (!task || task.type !== 'task') {
      throw new Error(`任务不存在：${input.task_id}`);
    }

    const oldStatus = task.status;
    if (!isValidTransition(TASK_TRANSITIONS, oldStatus as any, input.new_status)) {
      throw new Error(`无效状态迁移：${oldStatus} → ${input.new_status}`);
    }

    const updated: TaskNode = {
      ...task as TaskNode,
      status: input.new_status,
      updated_at: new Date().toISOString(),
    };
    await tx.nodes.update(updated);

    const event = await tx.events.emit({
      event_type: 'task.status_changed',
      operation: 'update_task_status',
      node_id: input.task_id,
      node_type: 'task',
      payload: { reason: input.reason ?? '' },
      diff: [{ field: 'status', old_value: oldStatus, new_value: input.new_status }],
      context: input.reason ?? null,
    });

    return { task: updated, event };
  });
}
