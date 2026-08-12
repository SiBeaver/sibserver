import { ulid } from 'ulidx';
import type { OperationContext } from './context.js';
import type { ExplorationNode } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';
import type { EventRecord } from '../events/types.js';
import { validateRelation } from '../edges/types.js';
import type { NodeType } from '../nodes/types.js';

// ============================================================
// begin_exploration — 开始探索
// ============================================================

export interface BeginExplorationInput {
  topic: string;
  hypothesis?: string;
  reason: string;
  approach?: string;
  related_goals?: string[];
  triggered_by?: string;
  tags?: string[];
}

export async function beginExploration(ctx: OperationContext, input: BeginExplorationInput) {
  return ctx.withTx(async (tx) => {
    const now = new Date().toISOString();
    const exploration: ExplorationNode = {
      id: ulid(),
      type: 'exploration',
      title: input.topic,
      description: input.reason,
      status: 'active',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      metadata: {},
      hypothesis: input.hypothesis ?? '',
      approach: input.approach ?? '',
      findings: [],
      conclusion: null,
      outcome: null,
    };

    await tx.nodes.insert(exploration);

    const edges_created: Edge[] = [];

    for (const goalId of input.related_goals ?? []) {
      const goal = await tx.nodes.getById(goalId);
      if (!goal || !validateRelation('spawns', goal.type as NodeType, 'exploration')) {
        throw new Error(`关联目标不存在或类型不符：${goalId}`);
      }
      const edge: Edge = {
        id: ulid(), source_id: goalId, target_id: exploration.id,
        relation: 'spawns', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    if (input.triggered_by) {
      const trigger = await tx.nodes.getById(input.triggered_by);
      if (!trigger || !validateRelation('spawns', trigger.type as NodeType, 'exploration')) {
        throw new Error(`触发节点不存在或类型不符：${input.triggered_by}`);
      }
      const edge: Edge = {
        id: ulid(), source_id: input.triggered_by, target_id: exploration.id,
        relation: 'spawns', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'exploration.started',
      operation: 'begin_exploration',
      node_id: exploration.id,
      node_type: 'exploration',
      payload: { topic: input.topic, reason: input.reason },
    });

    return { exploration, edges_created, event };
  });
}

// ============================================================
// record_exploration_finding — 记录探索发现
// ============================================================

export interface RecordFindingInput {
  exploration_id: string;
  finding: string;
  significance: 'minor' | 'major' | 'breakthrough';
  related_nodes?: string[];
}

export async function recordExplorationFinding(ctx: OperationContext, input: RecordFindingInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.exploration_id);
    if (!node || node.type !== 'exploration') {
      throw new Error(`探索不存在：${input.exploration_id}`);
    }
    if (node.status !== 'active') {
      throw new Error(`探索不在活跃状态：${node.status}`);
    }

    const exploration = node as ExplorationNode;
    const updated: ExplorationNode = {
      ...exploration,
      findings: [...exploration.findings, input.finding],
      updated_at: new Date().toISOString(),
    };
    await tx.nodes.update(updated);

    const edges_created: Edge[] = [];
    const now = new Date().toISOString();
    for (const relId of input.related_nodes ?? []) {
      const edge: Edge = {
        id: ulid(), source_id: input.exploration_id, target_id: relId,
        relation: 'relates_to', weight: null,
        annotation: `Finding: ${input.finding.slice(0, 50)}`,
        created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'exploration.finding_recorded',
      operation: 'record_exploration_finding',
      node_id: input.exploration_id,
      node_type: 'exploration',
      payload: { finding: input.finding, significance: input.significance },
    });

    return { exploration: updated, edges_created, event };
  });
}

// ============================================================
// conclude_exploration — 结论化探索
// ============================================================

export interface ConcludeExplorationInput {
  exploration_id: string;
  conclusion: string;
  outcome: 'validated' | 'invalidated' | 'partial' | 'inconclusive';
  decisions?: {
    title: string;
    context?: string;
    rationale: string;
    consequences?: string[];
  }[];
  knowledge?: {
    title: string;
    domain: string;
    description: string;
    confidence?: 'low' | 'medium' | 'high';
  }[];
}

export async function concludeExploration(ctx: OperationContext, input: ConcludeExplorationInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.exploration_id);
    if (!node || node.type !== 'exploration') {
      throw new Error(`探索不存在：${input.exploration_id}`);
    }
    if (node.status !== 'active') {
      throw new Error(`探索不在活跃状态：${node.status}`);
    }

    const now = new Date().toISOString();
    const exploration = node as ExplorationNode;
    const updated: ExplorationNode = {
      ...exploration,
      status: 'concluded',
      conclusion: input.conclusion,
      outcome: input.outcome,
      updated_at: now,
    };
    await tx.nodes.update(updated);

    const decisions_created: any[] = [];
    const knowledge_created: any[] = [];
    const edges_created: Edge[] = [];

    // 创建决策节点
    for (const d of input.decisions ?? []) {
      const decision = {
        id: ulid(), type: 'decision' as const, title: d.title,
        description: '', status: 'accepted' as const,
        tags: [], created_at: now, updated_at: now, metadata: {},
        context: d.context ?? input.conclusion,
        rationale: d.rationale,
        alternatives_considered: [],
        consequences: d.consequences ?? [],
        superseded_by: null,
      };
      await tx.nodes.insert(decision);
      decisions_created.push(decision);

      const edge: Edge = {
        id: ulid(), source_id: input.exploration_id, target_id: decision.id,
        relation: 'produces', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    // 创建知识节点
    for (const k of input.knowledge ?? []) {
      const knowledge = {
        id: ulid(), type: 'knowledge' as const, title: k.title,
        description: k.description, status: 'established' as const,
        tags: [], created_at: now, updated_at: now, metadata: {},
        domain: k.domain,
        confidence: k.confidence ?? 'medium' as const,
        source: `Exploration: ${exploration.title}`,
        scope: 'project' as const,
        valid_until: null,
        content: '', parent_id: null, pinned: false, sort_order: 0,
      };
      await tx.nodes.insert(knowledge);
      knowledge_created.push(knowledge);

      const edge: Edge = {
        id: ulid(), source_id: input.exploration_id, target_id: knowledge.id,
        relation: 'produces', weight: null, annotation: null, created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'exploration.concluded',
      operation: 'conclude_exploration',
      node_id: input.exploration_id,
      node_type: 'exploration',
      payload: {
        conclusion: input.conclusion,
        outcome: input.outcome,
        decisions: decisions_created.length,
        knowledge: knowledge_created.length,
      },
    });

    return { exploration: updated, decisions_created, knowledge_created, edges_created, event };
  });
}

// ============================================================
// abandon_exploration — 放弃探索
// ============================================================

export interface AbandonExplorationInput {
  exploration_id: string;
  reason: string;
  learnings?: string;
}

export async function abandonExploration(ctx: OperationContext, input: AbandonExplorationInput) {
  return ctx.withTx(async (tx) => {
    const node = await tx.nodes.getById(input.exploration_id);
    if (!node || node.type !== 'exploration') {
      throw new Error(`探索不存在：${input.exploration_id}`);
    }
    if (node.status !== 'active') {
      throw new Error(`探索不在活跃状态：${node.status}`);
    }

    const now = new Date().toISOString();
    const updated: ExplorationNode = {
      ...node as ExplorationNode,
      status: 'abandoned',
      conclusion: input.reason,
      updated_at: now,
    };
    await tx.nodes.update(updated);

    let knowledge_created = null;
    const edges_created: Edge[] = [];

    if (input.learnings) {
      knowledge_created = {
        id: ulid(), type: 'knowledge' as const, title: `从失败探索中学到: ${(node as ExplorationNode).title}`,
        description: input.learnings, status: 'established' as const,
        tags: ['failure-learning'], created_at: now, updated_at: now, metadata: {},
        domain: 'lessons-learned',
        confidence: 'medium' as const,
        source: `Abandoned exploration: ${(node as ExplorationNode).title}`,
        scope: 'project' as const,
        valid_until: null,
        content: '', parent_id: null, pinned: false, sort_order: 0,
      };
      await tx.nodes.insert(knowledge_created);

      const edge: Edge = {
        id: ulid(), source_id: input.exploration_id, target_id: knowledge_created.id,
        relation: 'produces', weight: null, annotation: '从失败中学习', created_at: now,
      };
      await tx.edges.insert(edge);
      edges_created.push(edge);
    }

    const event = await tx.events.emit({
      event_type: 'exploration.abandoned',
      operation: 'abandon_exploration',
      node_id: input.exploration_id,
      node_type: 'exploration',
      payload: { reason: input.reason, has_learnings: !!input.learnings },
      context: input.reason,
    });

    return { exploration: updated, knowledge_created, edges_created, event };
  });
}
