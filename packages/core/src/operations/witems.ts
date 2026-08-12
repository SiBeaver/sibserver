import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { WitemNode } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';
import type { EventRecord } from '../events/types.js';
import { isValidTransition, WITEM_TRANSITIONS } from '../lifecycle/machines.js';

// ============================================================
// define_witem — 定义工作项（人审的跨会话承诺）
// ============================================================

export interface DefineWitemInput {
  title: string;
  description?: string;
  horizon: 'short' | 'medium' | 'long';
  success_criteria?: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
  parent_witem?: string;
  tags?: string[];
}

export interface DefineWitemResult {
  witem: WitemNode;
  edges_created: Edge[];
  event: EventRecord;
}

export async function defineWitem(ctx: OperationContext, input: DefineWitemInput): Promise<DefineWitemResult> {
  return ctx.withTx(async (tx) => {
    if (input.parent_witem) {
      const parent = await tx.nodes.getById(input.parent_witem);
      if (!parent || parent.type !== 'witem') {
        throw new Error(`父工作项不存在：${input.parent_witem}`);
      }
    }

    const now = new Date().toISOString();
    const witem: WitemNode = {
      id: ulid(),
      type: 'witem',
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

    await tx.nodes.insert(witem);

    const edges_created: Edge[] = [];

    if (input.parent_witem) {
      const edge: Edge = {
        id: ulid(),
        source_id: input.parent_witem,
        target_id: witem.id,
        relation: 'decomposes_into',
        weight: null,
        annotation: null,
        created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'witem.defined',
      operation: 'define_witem',
      node_id: witem.id,
      node_type: 'witem',
      payload: { ...input },
      context: null,
    });

    return { witem, edges_created, event };
  });
}

// ============================================================
// decompose_witem — 分解工作项
// ============================================================

export interface DecomposeWitemInput {
  witem_id: string;
  sub_witems?: {
    title: string;
    description?: string;
    horizon: 'short' | 'medium' | 'long';
    success_criteria?: string[];
    priority?: 'critical' | 'high' | 'medium' | 'low';
  }[];
}

export async function decomposeWitem(ctx: OperationContext, input: DecomposeWitemInput) {
  return ctx.withTx(async (tx) => {
    const now = new Date().toISOString();
    const parent = await tx.nodes.getById(input.witem_id);
    if (!parent || parent.type !== 'witem') {
      throw new Error(`工作项不存在：${input.witem_id}`);
    }

    const sub_witems_created: WitemNode[] = [];
    const edges_created: Edge[] = [];

    for (const sw of input.sub_witems ?? []) {
      const node: WitemNode = {
        id: ulid(), type: 'witem', title: sw.title,
        description: sw.description ?? '', status: 'active',
        tags: [], created_at: now, updated_at: now, metadata: {},
        horizon: sw.horizon, success_criteria: sw.success_criteria ?? [],
        priority: sw.priority ?? 'medium',
      };
      await tx.nodes.insert(node);
      sub_witems_created.push(node);

      const edge: Edge = {
        id: ulid(), source_id: input.witem_id, target_id: node.id,
        relation: 'decomposes_into', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'witem.decomposed',
      operation: 'decompose_witem',
      node_id: input.witem_id,
      node_type: 'witem',
      payload: {
        sub_witems: sub_witems_created.length,
      },
    });

    return { sub_witems_created, edges_created, event };
  });
}

// ============================================================
// update_witem_status — 更新工作项状态
// ============================================================

export interface UpdateWitemStatusInput {
  witem_id: string;
  new_status: 'active' | 'achieved' | 'abandoned' | 'deferred';
  reason: string;
}

export async function updateWitemStatus(ctx: OperationContext, input: UpdateWitemStatusInput) {
  return ctx.withTx(async (tx) => {
    const witem = await tx.nodes.getById(input.witem_id);
    if (!witem || witem.type !== 'witem') {
      throw new Error(`工作项不存在：${input.witem_id}`);
    }

    const oldStatus = witem.status;
    if (!isValidTransition(WITEM_TRANSITIONS, oldStatus as any, input.new_status)) {
      throw new Error(`无效状态迁移：${oldStatus} → ${input.new_status}`);
    }

    const updated: WitemNode = {
      ...witem as WitemNode,
      status: input.new_status,
      updated_at: new Date().toISOString(),
    };
    await tx.nodes.update(updated);

    const event = await tx.events.emit({
      event_type: 'witem.status_changed',
      operation: 'update_witem_status',
      node_id: input.witem_id,
      node_type: 'witem',
      payload: { reason: input.reason },
      diff: [{ field: 'status', old_value: oldStatus, new_value: input.new_status }],
      context: input.reason,
    });

    return { witem: updated, event };
  });
}
