import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { Edge } from '../edges/types.js';
import type { KnowledgeNode } from '../nodes/types.js';
import { validateRelation } from '../edges/types.js';
import type { NodeType } from '../nodes/types.js';

// ============================================================
// record_knowledge — 记录知识
// ============================================================

export interface RecordKnowledgeInput {
  title: string;
  description: string;
  domain: string;
  confidence?: 'low' | 'medium' | 'high';
  source: string;
  scope?: 'project' | 'domain';
  content?: string;
  parent_id?: string | null;
  pinned?: boolean;
  derived_from?: string[];
  invalidates?: string[];
  tags?: string[];
}

export async function recordKnowledge(ctx: OperationContext, input: RecordKnowledgeInput) {
  return ctx.withTx(async (tx) => {
    const now = new Date().toISOString();
    const knowledge: KnowledgeNode = {
      id: ulid(),
      type: 'knowledge',
      title: input.title,
      description: input.description,
      status: 'established',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      metadata: {},
      domain: input.domain,
      confidence: input.confidence ?? 'medium',
      source: input.source,
      scope: input.scope ?? 'project',
      valid_until: null,
      content: input.content ?? '',
      parent_id: input.parent_id ?? null,
      pinned: input.pinned ?? false,
      sort_order: 0,
    };

    await tx.nodes.insert(knowledge);
    const edges_created: Edge[] = [];
    const invalidated_nodes: KnowledgeNode[] = [];

    for (const fromId of input.derived_from ?? []) {
      const from = await tx.nodes.getById(fromId);
      if (!from || !validateRelation('derived_from', from.type as NodeType, 'knowledge')) {
        throw new Error(`来源节点不存在或类型不符：${fromId}`);
      }
      const edge: Edge = {
        id: ulid(), source_id: fromId, target_id: knowledge.id,
        relation: 'derived_from', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    for (const oldId of input.invalidates ?? []) {
      const oldNode = await tx.nodes.getById(oldId);
      if (oldNode && oldNode.type === 'knowledge') {
        const updated = { ...oldNode as KnowledgeNode, status: 'outdated' as const, updated_at: now };
        await tx.nodes.update(updated);
        invalidated_nodes.push(updated);

        const edge: Edge = {
          id: ulid(), source_id: knowledge.id, target_id: oldId,
          relation: 'supersedes', weight: null, annotation: null, created_at: now,
        };
        await tx.edges.insert(edge);
        edges_created.push(edge);
      }
    }

    const event = await tx.events.emit({
      event_type: 'knowledge.recorded',
      operation: 'record_knowledge',
      node_id: knowledge.id,
      node_type: 'knowledge',
      payload: { title: input.title, domain: input.domain, confidence: knowledge.confidence },
    });

    return { knowledge, invalidated_nodes, edges_created, event };
  });
}

// ============================================================
// update_knowledge — 更新知识
// ============================================================

export interface UpdateKnowledgeInput {
  knowledge_id: string;
  title?: string;
  description?: string;
  content?: string;
  domain?: string;
  confidence?: 'low' | 'medium' | 'high';
  scope?: 'project' | 'domain';
  status?: 'tentative' | 'established' | 'outdated';
  tags?: string[];
  parent_id?: string | null;
}

export async function updateKnowledge(ctx: OperationContext, input: UpdateKnowledgeInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.knowledge_id);
    if (!node || node.type !== 'knowledge') {
      throw new Error(`知识节点不存在：${input.knowledge_id}`);
    }

    const now = new Date().toISOString();
    const updated: KnowledgeNode = {
      ...(node as KnowledgeNode),
      title: input.title ?? node.title,
      description: input.description ?? node.description,
      content: input.content ?? (node as any).content ?? '',
      domain: input.domain ?? (node as KnowledgeNode).domain,
      confidence: input.confidence ?? (node as KnowledgeNode).confidence,
      scope: input.scope ?? (node as KnowledgeNode).scope ?? 'project',
      status: input.status ?? node.status as any,
      tags: input.tags ?? node.tags,
      parent_id: input.parent_id !== undefined ? input.parent_id : (node as any).parent_id ?? null,
      updated_at: now,
    };

    await tx.nodes.update(updated);

    const event = await tx.events.emit({
      event_type: 'knowledge.recorded',
      operation: 'update_knowledge',
      node_id: updated.id,
      node_type: 'knowledge',
      payload: { title: updated.title, domain: updated.domain },
    });

    return { knowledge: updated, event };
  });
}

// ============================================================
// knowledge tree operations
// ============================================================

export interface KnowledgeTreeNode {
  id: string;
  title: string;
  domain: string;
  description: string;
  content: string;
  status: string;
  confidence: string;
  scope: string;
  pinned: boolean;
  sort_order: number;
  parent_id: string | null;
  children: KnowledgeTreeNode[];
  tags: string[];
  updated_at: string;
  source: string;
}

export async function getKnowledgeTree(ctx: OperationContext) {
  const allNodes = await ctx.nodes.getKnowledgeTree();

  const nodeMap = new Map<string, KnowledgeTreeNode>();
  const roots: KnowledgeTreeNode[] = [];

  for (const n of allNodes) {
    const kn = n as KnowledgeNode;
    nodeMap.set(n.id, {
      id: n.id,
      title: n.title,
      domain: kn.domain,
      description: n.description,
      content: kn.content || '',
      status: n.status,
      confidence: kn.confidence,
      scope: kn.scope || 'project',
      pinned: kn.pinned,
      sort_order: kn.sort_order,
      parent_id: kn.parent_id,
      children: [],
      tags: n.tags,
      updated_at: n.updated_at,
      source: kn.source,
    });
  }

  for (const tn of nodeMap.values()) {
    if (tn.parent_id && nodeMap.has(tn.parent_id)) {
      nodeMap.get(tn.parent_id)!.children.push(tn);
    } else {
      roots.push(tn);
    }
  }

  return { tree: roots, total: allNodes.length };
}

export async function pinKnowledge(ctx: OperationContext, input: { knowledge_id: string; pinned: boolean }) {
  const node = await ctx.nodes.getById(input.knowledge_id);
  if (!node || node.type !== 'knowledge') throw new Error('知识节点不存在');
  await ctx.nodes.updatePinned(input.knowledge_id, input.pinned);
  return { id: input.knowledge_id, pinned: input.pinned };
}

export async function moveKnowledge(ctx: OperationContext, input: { knowledge_id: string; parent_id: string | null; sort_order?: number }) {
  const node = await ctx.nodes.getById(input.knowledge_id);
  if (!node || node.type !== 'knowledge') throw new Error('知识节点不存在');
  if ((node as KnowledgeNode).pinned && input.parent_id !== (node as any).parent_id) {
    throw new Error('不能移动已固定的知识节点，请先取消固定');
  }
  await ctx.nodes.updateParent(input.knowledge_id, input.parent_id, input.sort_order);
  return { id: input.knowledge_id, parent_id: input.parent_id };
}
