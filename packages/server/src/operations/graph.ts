import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { Edge } from '../edges/types.js';
import { validateRelation, type RelationType } from '../edges/types.js';
import type { NodeType } from '../nodes/types.js';

// ============================================================
// link_nodes — 关联节点
// ============================================================

export interface LinkNodesInput {
  source_id: string;
  target_id: string;
  relation: RelationType;
  annotation?: string;
}

export async function linkNodes(ctx: OperationContext, input: LinkNodesInput) {
  const source = await ctx.nodes.getById(input.source_id);
  if (!source) throw new Error(`源节点不存在：${input.source_id}`);

  const target = await ctx.nodes.getById(input.target_id);
  if (!target) throw new Error(`目标节点不存在：${input.target_id}`);

  if (!validateRelation(input.relation, source.type as NodeType, target.type as NodeType)) {
    throw new Error(
      `无效关系「${input.relation}」：${source.type} → ${target.type}`
    );
  }

  const now = new Date().toISOString();
  const edge: Edge = {
    id: ulid(),
    source_id: input.source_id,
    target_id: input.target_id,
    relation: input.relation,
    weight: null,
    annotation: input.annotation ?? null,
    created_at: now,
  };

  await ctx.edges.insert(edge);

  const event = await ctx.events.emit({
    event_type: 'graph.edge_created',
    operation: 'link_nodes',
    node_id: input.source_id,
    node_type: source.type,
    payload: {
      source_id: input.source_id,
      target_id: input.target_id,
      relation: input.relation,
    },
  });

  return { edge, event };
}

// ============================================================
// delete_node — 删除节点及其关联边
// ============================================================

export interface DeleteNodeInput {
  node_id: string;
  reason?: string;
}

export async function deleteNode(ctx: OperationContext, input: DeleteNodeInput) {
  const node = await ctx.nodes.getById(input.node_id);
  if (!node) throw new Error(`节点不存在：${input.node_id}`);

  // 删除所有关联边
  const edges = await ctx.edges.getByNode(input.node_id);
  for (const edge of edges) {
    await ctx.edges.delete(edge.id);
  }

  // 删除节点
  await ctx.nodes.delete(input.node_id);

  // 记录事件
  const event = await ctx.events.emit({
    event_type: 'graph.node_deleted',
    operation: 'delete_node',
    node_id: input.node_id,
    node_type: node.type,
    payload: { title: node.title, type: node.type, edges_removed: edges.length },
    context: input.reason ?? null,
  });

  return { deleted_node: { id: node.id, type: node.type, title: node.title }, edges_removed: edges.length, event };
}

// ============================================================
// get_project_state — 获取项目状态
// ============================================================

export async function getProjectState(ctx: OperationContext) {
  const goals = await ctx.nodes.getByType('goal');
  const active_goals = goals.filter(g => g.status === 'active');
  const tasks = await ctx.nodes.getByType('task');
  const open_tasks = tasks.filter(t => !['done', 'cancelled'].includes(t.status));
  const explorations = await ctx.nodes.getByTypeAndStatus('exploration', 'active');
  const recent_decisions = (await ctx.nodes.getByType('decision'))
    .filter(d => !['superseded', 'deprecated'].includes(d.status))
    .slice(-10);
  const open_risks = (await ctx.nodes.getByType('risk')).filter(r => !['resolved', 'accepted'].includes(r.status));
  const tech_debt = (await ctx.nodes.getByType('tech_debt')).filter(td => td.status !== 'resolved');
  const requirements = await ctx.nodes.getByType('requirement');
  const open_requirements = requirements.filter(r => !['satisfied', 'deprecated'].includes(r.status));

  return {
    active_goals,
    open_tasks,
    active_explorations: explorations,
    recent_decisions,
    open_risks,
    critical_tech_debt: tech_debt.filter(td => ['high', 'critical'].includes((td as any).severity)),
    requirements,
    open_requirements,
    statistics: {
      total_goals: goals.length,
      achieved_goals: goals.filter(g => g.status === 'achieved').length,
      total_tasks: tasks.length,
      done_tasks: tasks.filter(t => t.status === 'done').length,
      active_explorations: explorations.length,
      open_risks: open_risks.length,
      tech_debt_items: tech_debt.length,
      total_requirements: requirements.length,
      open_requirements: open_requirements.length,
    },
  };
}

// ============================================================
// get_node_context — 获取节点上下文
// ============================================================

export async function getNodeContext(ctx: OperationContext, nodeId: string, includeEvents = true) {
  const node = await ctx.nodes.getById(nodeId);
  if (!node) throw new Error(`节点不存在：${nodeId}`);

  const edges = await ctx.edges.getByNode(nodeId);
  const neighborIds = new Set<string>();
  for (const e of edges) {
    if (e.source_id !== nodeId) neighborIds.add(e.source_id);
    if (e.target_id !== nodeId) neighborIds.add(e.target_id);
  }

  const neighbors = (await Promise.all(
    [...neighborIds].map(id => ctx.nodes.getById(id))
  )).filter(Boolean);

  const events = includeEvents
    ? await ctx.eventStore.getByNode(nodeId)
    : [];

  return { node, edges, neighbors, events };
}

