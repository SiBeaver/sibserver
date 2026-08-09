import type { OperationContext } from './context.js';
import type { CognitiveNode, GoalNode } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';

// ============================================================
// get_roadmap — 获取目标路线图（树状结构）
// ============================================================

export interface GetRoadmapInput {
  root_goal?: string;
  include_completed?: boolean;
  max_depth?: number;
}

export interface RoadmapItem {
  node: CognitiveNode;
  children: RoadmapItem[];
  progress: { total: number; done: number };
}

export async function getRoadmap(ctx: OperationContext, input: GetRoadmapInput = {}) {
  const maxDepth = input.max_depth ?? 3;
  const includeCompleted = input.include_completed ?? false;

  async function buildTree(nodeId: string, depth: number): Promise<RoadmapItem | null> {
    const node = await ctx.nodes.getById(nodeId);
    if (!node) return null;
    if (!includeCompleted && (node.status === 'achieved' || node.status === 'abandoned' || node.status === 'concluded' || node.status === 'deprecated')) {
      return null;
    }

    const children: RoadmapItem[] = [];
    if (depth < maxDepth) {
      const edges = await ctx.edges.getBySource(nodeId);
      for (const edge of edges) {
        if (edge.relation === 'decomposes_into' || edge.relation === 'spawns') {
          const child = await buildTree(edge.target_id, depth + 1);
          if (child) children.push(child);
        }
      }
    }

    let total = 0;
    let done = 0;
    if (children.length > 0) {
      for (const c of children) {
        total += c.progress.total;
        done += c.progress.done;
      }
    } else {
      total = 1;
      done = (node.status === 'achieved' || node.status === 'concluded') ? 1 : 0;
    }

    return { node, children, progress: { total, done } };
  }

  if (input.root_goal) {
    const tree = await buildTree(input.root_goal, 0);
    if (!tree) throw new Error(`目标不存在：${input.root_goal}`);
    return { roadmap: [tree] };
  }

  // 找所有顶层 goal（没有父 goal 的）
  const allGoals = await ctx.nodes.getByType('goal');
  const childGoalIds = new Set<string>();
  for (const goal of allGoals) {
    const incomingEdges = await ctx.edges.getByTarget(goal.id);
    for (const e of incomingEdges) {
      if (e.relation === 'decomposes_into') {
        childGoalIds.add(goal.id);
      }
    }
  }

  const rootGoals = allGoals.filter(g => !childGoalIds.has(g.id));
  const roadmap: RoadmapItem[] = [];
  for (const g of rootGoals) {
    if (!includeCompleted && (g.status === 'achieved' || g.status === 'abandoned')) continue;
    const tree = await buildTree(g.id, 0);
    if (tree) roadmap.push(tree);
  }

  return { roadmap };
}

// ============================================================
// goal_progress — 目标进度（含子项完成率）
// ============================================================

export async function goalProgress(ctx: OperationContext) {
  const goals = await ctx.nodes.getByType('goal');
  const results: { goal: CognitiveNode; total: number; done: number; percentage: number }[] = [];

  for (const goal of goals) {
    if (goal.status !== 'active') continue;
    const edges = await ctx.edges.getBySource(goal.id);
    const subItems = (await Promise.all(
      edges
        .filter(e => e.relation === 'decomposes_into' || e.relation === 'spawns')
        .map(e => ctx.nodes.getById(e.target_id))
    )).filter(Boolean) as CognitiveNode[];

    const total = subItems.length;
    const done = subItems.filter(n =>
      n.status === 'achieved' || n.status === 'concluded' || n.status === 'done'
    ).length;
    const percentage = total > 0 ? Math.round((done / total) * 100) : 0;

    results.push({ goal, total, done, percentage });
  }

  return { goals: results };
}

// ============================================================
// decision_trail — 追溯决策/探索链
// ============================================================

export async function decisionTrail(ctx: OperationContext, nodeId: string) {
  const trail: { node: CognitiveNode; relation: string; direction: 'incoming' | 'outgoing' }[] = [];
  const visited = new Set<string>();

  async function trace(id: string) {
    if (visited.has(id)) return;
    visited.add(id);

    const edges = await ctx.edges.getByNode(id);
    for (const edge of edges) {
      const isRelevant = ['produces', 'informs', 'spawns', 'creates', 'derived_from', 'supersedes'].includes(edge.relation);
      if (!isRelevant) continue;

      // 向上追溯 — 找到指向当前节点的源
      if (edge.target_id === id && !visited.has(edge.source_id)) {
        const sourceNode = await ctx.nodes.getById(edge.source_id);
        if (sourceNode) {
          trail.push({ node: sourceNode, relation: edge.relation, direction: 'incoming' });
          await trace(edge.source_id);
        }
      }
    }
  }

  const rootNode = await ctx.nodes.getById(nodeId);
  if (!rootNode) throw new Error(`节点不存在：${nodeId}`);

  await trace(nodeId);
  return { root: rootNode, trail };
}

// ============================================================
// knowledge_map — 按领域查看知识
// ============================================================

export async function knowledgeMap(ctx: OperationContext, domain?: string) {
  const allKnowledge = await ctx.nodes.getByType('knowledge');
  const filtered = allKnowledge
    .filter(k => !STALE_STATUSES.includes(k.status))
    .filter(k => !domain || (k as any).domain === domain)
    .sort((a, b) => sortScore(b) - sortScore(a));

  // 按 domain 分组
  const byDomain: Record<string, CognitiveNode[]> = {};
  for (const k of filtered) {
    const d = (k as any).domain as string;
    (byDomain[d] ??= []).push(k);
  }

  return { knowledge: filtered, by_domain: byDomain };
}

// ============================================================
// stale_items — 长时间未更新的节点
// ============================================================

export async function staleItems(ctx: OperationContext, days: number = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const activeStatuses = ['active', 'proposed', 'identified', 'analyzing', 'accepted'];
  const types = ['goal', 'exploration', 'risk', 'tech_debt'] as const;

  const stale: CognitiveNode[] = [];
  for (const type of types) {
    const nodes = await ctx.nodes.getByType(type);
    for (const node of nodes) {
      if (activeStatuses.includes(node.status) && node.updated_at < cutoff) {
        stale.push(node);
      }
    }
  }

  stale.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return { stale_items: stale, cutoff_date: cutoff, days };
}

// ============================================================
// current_blockers — 阻塞活跃目标/任务的风险和技术债
// ============================================================

export async function currentBlockers(ctx: OperationContext) {
  const risks = (await ctx.nodes.getByType('risk')).filter(r => !['resolved', 'mitigated'].includes(r.status));
  const techDebt = (await ctx.nodes.getByType('tech_debt')).filter(td => td.status !== 'resolved');

  const blockers: { blocker: CognitiveNode; blocks: CognitiveNode[] }[] = [];

  for (const item of [...risks, ...techDebt]) {
    const edges = await ctx.edges.getBySource(item.id);
    const blocking = (await Promise.all(
      edges
        .filter(e => e.relation === 'blocks')
        .map(e => ctx.nodes.getById(e.target_id))
    )).filter(Boolean) as CognitiveNode[];

    if (blocking.length > 0) {
      blockers.push({ blocker: item, blocks: blocking });
    }
  }

  return { blockers };
}

// ============================================================
// recent_activity — 最近事件
// ============================================================

export async function recentActivity(ctx: OperationContext, limit: number = 20) {
  const events = await ctx.eventStore.getRecent(limit);
  return { events };
}

// ============================================================
// full_text_search — 全文搜索（操作层封装）
// ============================================================

/** 被视为"已失效"的节点状态，默认从检索结果中过滤 */
const STALE_STATUSES = ['superseded', 'outdated', 'deprecated'];

/** 结构化排序权重：confidence → 时间（新优先） */
function sortScore(node: CognitiveNode): number {
  const confidenceMap: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const confidence = (node as any).confidence as string | undefined;
  const cScore = confidenceMap[confidence ?? 'medium'] ?? 2;
  const tScore = new Date(node.updated_at).getTime() / 1e12; // 归一化到 ~1.7
  return cScore + tScore;
}

export async function fullTextSearch(ctx: OperationContext, query: string) {
  const raw = await ctx.nodes.search(query);
  const results = raw
    .filter(n => !STALE_STATUSES.includes(n.status))
    .sort((a, b) => sortScore(b) - sortScore(a));
  return { query, results, count: results.length };
}

// ============================================================
// helm_signals — 聚合需要人类转向的力矩
// ============================================================

export type HelmSignalType = 'proposed_requirement' | 'revision_needed' | 'knowledge_conflict' | 'blocker' | 'stale' | 'goal_review';

export interface HelmSignal {
  id: string;
  type: HelmSignalType;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  summary: string;
  node: CognitiveNode;
  context: { nodes: CognitiveNode[]; edges: Edge[] };
  timestamp: string;
}

export interface HelmResponse {
  signals: HelmSignal[];
  counts: Record<string, number>;
}

const URGENCY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function priorityToUrgency(priority?: string): HelmSignal['urgency'] {
  if (priority === 'critical') return 'critical';
  if (priority === 'high') return 'high';
  if (priority === 'medium') return 'medium';
  return 'low';
}

export async function getHelmSignals(ctx: OperationContext): Promise<HelmResponse> {
  const signals: HelmSignal[] = [];

  const proposed = await ctx.nodes.getByTypeAndStatus('requirement', 'proposed');
  for (const node of proposed) {
    signals.push({
      id: `proposed-${node.id}`,
      type: 'proposed_requirement',
      urgency: priorityToUrgency((node as any).priority),
      title: node.title,
      summary: '待精炼需求，需要确认或驳回',
      node,
      context: { nodes: [], edges: [] },
      timestamp: node.created_at,
    });
  }

  const revisionNeeded = await ctx.nodes.getByTypeAndStatus('requirement', 'revision_needed');
  for (const node of revisionNeeded) {
    const inEdges = await ctx.edges.getByTarget(node.id);
    const contradictEdges = inEdges.filter(e => e.relation === 'contradicts');
    const contextNodes = (await Promise.all(
      contradictEdges.map(e => ctx.nodes.getById(e.source_id))
    )).filter(Boolean) as CognitiveNode[];

    signals.push({
      id: `revision-${node.id}`,
      type: 'revision_needed',
      urgency: 'high',
      title: node.title,
      summary: contextNodes.length > 0
        ? `知识冲突：${contextNodes.map(n => n.title).join('、')}`
        : '需要修订',
      node,
      context: { nodes: contextNodes, edges: contradictEdges },
      timestamp: node.updated_at,
    });

    for (const kNode of contextNodes) {
      const edge = contradictEdges.find(e => e.source_id === kNode.id)!;
      signals.push({
        id: `conflict-${edge.id}`,
        type: 'knowledge_conflict',
        urgency: 'critical',
        title: `${kNode.title} ⇄ ${node.title}`,
        summary: edge.annotation || '知识与需求冲突，需要裁决',
        node: kNode,
        context: { nodes: [node], edges: [edge] },
        timestamp: edge.created_at,
      });
    }
  }

  const risks = (await ctx.nodes.getByType('risk')).filter(r => !['resolved', 'mitigated'].includes(r.status));
  const techDebt = (await ctx.nodes.getByType('tech_debt')).filter(td => td.status !== 'resolved');
  for (const item of [...risks, ...techDebt]) {
    const edges = await ctx.edges.getBySource(item.id);
    const blockingEdges = edges.filter(e => e.relation === 'blocks');
    if (blockingEdges.length === 0) continue;
    const blocked = (await Promise.all(
      blockingEdges.map(e => ctx.nodes.getById(e.target_id))
    )).filter(Boolean) as CognitiveNode[];

    signals.push({
      id: `blocker-${item.id}`,
      type: 'blocker',
      urgency: (item as any).severity === 'critical' ? 'critical' : 'high',
      title: item.title,
      summary: `阻塞：${blocked.map(n => n.title).join('、')}`,
      node: item,
      context: { nodes: blocked, edges: blockingEdges },
      timestamp: item.updated_at,
    });
  }

  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const staleTypes = ['goal', 'exploration', 'risk', 'tech_debt'] as const;
  const staleStatuses = ['active', 'proposed', 'identified', 'analyzing', 'accepted'];
  for (const type of staleTypes) {
    const nodes = await ctx.nodes.getByType(type);
    for (const node of nodes) {
      if (staleStatuses.includes(node.status) && node.updated_at < cutoff7d) {
        signals.push({
          id: `stale-${node.id}`,
          type: 'stale',
          urgency: node.updated_at < cutoff14d ? 'high' : 'medium',
          title: node.title,
          summary: `已停滞 ${Math.floor((Date.now() - new Date(node.updated_at).getTime()) / 86400000)} 天`,
          node,
          context: { nodes: [], edges: [] },
          timestamp: node.updated_at,
        });
      }
    }
  }

  const activeGoals = await ctx.nodes.getByTypeAndStatus('goal', 'active');
  const cutoff3d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  for (const goal of activeGoals) {
    const edges = await ctx.edges.getBySource(goal.id);
    const decomposeEdges = edges.filter(e => e.relation === 'decomposes_into');
    const children = (await Promise.all(
      decomposeEdges.map(e => ctx.nodes.getById(e.target_id))
    )).filter(Boolean) as CognitiveNode[];
    const recentChildren = children.filter(c => c.created_at > cutoff3d);
    if (recentChildren.length > 0) {
      signals.push({
        id: `goal-review-${goal.id}`,
        type: 'goal_review',
        urgency: 'medium',
        title: goal.title,
        summary: `AI 刚分解出 ${recentChildren.length} 个子项，请确认方向`,
        node: goal,
        context: { nodes: recentChildren, edges: decomposeEdges },
        timestamp: recentChildren[0].created_at,
      });
    }
  }

  signals.sort((a, b) => {
    const urgDiff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (urgDiff !== 0) return urgDiff;
    return b.timestamp.localeCompare(a.timestamp);
  });

  const counts: Record<string, number> = {};
  for (const s of signals) {
    counts[s.type] = (counts[s.type] || 0) + 1;
  }

  return { signals, counts };
}
