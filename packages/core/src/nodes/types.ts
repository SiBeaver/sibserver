import { z } from 'zod';

// ============================================================
// 共享枚举
// ============================================================

export const NodeType = z.enum([
  'goal',
  'task',
  'exploration',
  'decision',
  'risk',
  'tech_debt',
  'artifact',
  'knowledge',
  'requirement',
]);
export type NodeType = z.infer<typeof NodeType>;

export const Priority = z.enum(['critical', 'high', 'medium', 'low']);
export type Priority = z.infer<typeof Priority>;

// ============================================================
// 各节点类型的 status 枚举
// ============================================================

export const GoalStatus = z.enum(['active', 'achieved', 'abandoned', 'deferred']);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const TaskStatus = z.enum(['open', 'in_progress', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const ExplorationStatus = z.enum(['proposed', 'active', 'concluded', 'abandoned']);
export type ExplorationStatus = z.infer<typeof ExplorationStatus>;

export const DecisionStatus = z.enum(['proposed', 'accepted', 'superseded', 'deprecated']);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const RiskStatus = z.enum(['identified', 'analyzing', 'mitigated', 'accepted', 'occurred', 'resolved']);
export type RiskStatus = z.infer<typeof RiskStatus>;

export const TechDebtStatus = z.enum(['identified', 'accepted', 'paying_down', 'resolved']);
export type TechDebtStatus = z.infer<typeof TechDebtStatus>;

export const ArtifactStatus = z.enum(['draft', 'active', 'archived']);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const KnowledgeStatus = z.enum(['tentative', 'established', 'outdated']);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>;

export const RequirementStatus = z.enum([
  'proposed', 'accepted', 'in_execution', 'revision_needed', 'satisfied', 'deprecated',
]);
export type RequirementStatus = z.infer<typeof RequirementStatus>;

// ============================================================
// 基础节点 schema
// ============================================================

export const BaseNode = z.object({
  id: z.string(),
  type: NodeType,
  title: z.string().max(200),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
});
export type BaseNode = z.infer<typeof BaseNode>;

// ============================================================
// 各节点类型 schema
// ============================================================

export const GoalNode = BaseNode.extend({
  type: z.literal('goal'),
  status: GoalStatus,
  horizon: z.enum(['short', 'medium', 'long']),
  success_criteria: z.array(z.string()).default([]),
  priority: Priority,
});
export type GoalNode = z.infer<typeof GoalNode>;

export const TaskNode = BaseNode.extend({
  type: z.literal('task'),
  status: TaskStatus,
  priority: Priority.default('medium'),
});
export type TaskNode = z.infer<typeof TaskNode>;

export const ExplorationNode = BaseNode.extend({
  type: z.literal('exploration'),
  status: ExplorationStatus,
  hypothesis: z.string().default(''),
  approach: z.string().default(''),
  findings: z.array(z.string()).default([]),
  conclusion: z.string().nullable().default(null),
  outcome: z.enum(['validated', 'invalidated', 'partial', 'inconclusive']).nullable().default(null),
});
export type ExplorationNode = z.infer<typeof ExplorationNode>;

export const AlternativeConsidered = z.object({
  option: z.string(),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  reason_rejected: z.string(),
});
export type AlternativeConsidered = z.infer<typeof AlternativeConsidered>;

export const DecisionNode = BaseNode.extend({
  type: z.literal('decision'),
  status: DecisionStatus,
  context: z.string(),
  rationale: z.string(),
  alternatives_considered: z.array(AlternativeConsidered).default([]),
  consequences: z.array(z.string()).default([]),
  superseded_by: z.string().nullable().default(null),
});
export type DecisionNode = z.infer<typeof DecisionNode>;

export const RiskNode = BaseNode.extend({
  type: z.literal('risk'),
  status: RiskStatus,
  likelihood: z.enum(['low', 'medium', 'high']),
  impact: z.enum(['low', 'medium', 'high', 'critical']),
  mitigation_strategy: z.string().nullable().default(null),
  trigger_conditions: z.array(z.string()).default([]),
});
export type RiskNode = z.infer<typeof RiskNode>;

export const TechDebtNode = BaseNode.extend({
  type: z.literal('tech_debt'),
  status: TechDebtStatus,
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  affected_area: z.string(),
  cost_of_delay: z.string(),
  resolution_approach: z.string().nullable().default(null),
});
export type TechDebtNode = z.infer<typeof TechDebtNode>;

export const ArtifactNode = BaseNode.extend({
  type: z.literal('artifact'),
  status: ArtifactStatus,
  artifact_type: z.enum(['document', 'design', 'pr', 'commit', 'prototype', 'spec', 'other']),
  uri: z.string().nullable().default(null),
  content_summary: z.string().nullable().default(null),
});
export type ArtifactNode = z.infer<typeof ArtifactNode>;

export const KnowledgeScope = z.enum(['project', 'domain']);
export type KnowledgeScope = z.infer<typeof KnowledgeScope>;

export const KnowledgeNode = BaseNode.extend({
  type: z.literal('knowledge'),
  status: KnowledgeStatus,
  domain: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  source: z.string(),
  scope: KnowledgeScope.default('project'),
  valid_until: z.string().nullable().default(null),
  content: z.string().default(''),
  parent_id: z.string().nullable().default(null),
  pinned: z.boolean().default(false),
  sort_order: z.number().default(0),
});
export type KnowledgeNode = z.infer<typeof KnowledgeNode>;

// ============================================================
// 验收标准 schema（基于 Constraint DSL，先 checklist，后续扩展）
// ============================================================

export const AcceptanceItem = z.object({
  id: z.string(),
  label: z.string(),
  satisfied: z.boolean().default(false),
});
export type AcceptanceItem = z.infer<typeof AcceptanceItem>;

export const ChecklistAcceptance = z.object({
  type: z.literal('checklist'),
  items: z.array(AcceptanceItem),
});
export type ChecklistAcceptance = z.infer<typeof ChecklistAcceptance>;

export const Acceptance = ChecklistAcceptance.nullable().default(null);
export type Acceptance = z.infer<typeof Acceptance>;

export const RequirementNode = BaseNode.extend({
  type: z.literal('requirement'),
  status: RequirementStatus,
  priority: Priority,
  source: z.string(),
  source_detail: z.string().nullable().default(null),
  acceptance: Acceptance,
});
export type RequirementNode = z.infer<typeof RequirementNode>;

// ============================================================
// 联合节点类型
// ============================================================

export const CognitiveNode = z.discriminatedUnion('type', [
  GoalNode,
  TaskNode,
  ExplorationNode,
  DecisionNode,
  RiskNode,
  TechDebtNode,
  ArtifactNode,
  KnowledgeNode,
  RequirementNode,
]);
export type CognitiveNode = z.infer<typeof CognitiveNode>;
