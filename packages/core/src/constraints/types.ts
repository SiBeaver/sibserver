import { z } from 'zod';

// ============================================================
// Constraint DSL — 约束定义语言
//
// 约束存储在 vibedocs JSON 文件中（git），不是 sibs 节点。
// sibs evaluator 接收约束 + 证据，返回评估结果。
// ============================================================

export const Dimension = z.enum([
  'security', 'performance', 'compliance', 'cost', 'reliability', 'quality',
]);
export type Dimension = z.infer<typeof Dimension>;

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

export const ComparisonOperator = z.enum(['lt', 'lte', 'gt', 'gte', 'eq', 'neq']);
export type ComparisonOperator = z.infer<typeof ComparisonOperator>;

// ── Condition types ─────────────────────────────────────────

export const MetricCondition = z.object({
  evidence_type: z.literal('metric'),
  metric: z.string(),
  operator: ComparisonOperator,
  threshold: z.number(),
  unit: z.string().optional(),
});
export type MetricCondition = z.infer<typeof MetricCondition>;

export const CodePatternCondition = z.object({
  evidence_type: z.literal('code_pattern'),
  scope: z.string(),
  pattern: z.string(),
  operator: z.enum(['present', 'absent', 'present_in_all', 'present_in_any']),
});
export type CodePatternCondition = z.infer<typeof CodePatternCondition>;

export const TestResultCondition = z.object({
  evidence_type: z.literal('test_result'),
  scope: z.string().optional(),
  metric: z.string(),
  operator: ComparisonOperator,
  threshold: z.number(),
  unit: z.string().optional(),
});
export type TestResultCondition = z.infer<typeof TestResultCondition>;

export const SibsQueryCondition = z.object({
  evidence_type: z.literal('sibs_query'),
  query: z.string(),
  operator: z.enum(['present', 'absent', 'match_count']),
  threshold: z.number().optional(),
  count_operator: ComparisonOperator.optional(),
});
export type SibsQueryCondition = z.infer<typeof SibsQueryCondition>;

export const Condition = z.discriminatedUnion('evidence_type', [
  MetricCondition,
  CodePatternCondition,
  TestResultCondition,
  SibsQueryCondition,
]);
export type Condition = z.infer<typeof Condition>;

// ── Constraint ──────────────────────────────────────────────

export const Constraint = z.object({
  id: z.string(),
  title: z.string(),
  dimension: Dimension,
  severity: Severity,
  description: z.string(),
  condition: Condition,
});
export type Constraint = z.infer<typeof Constraint>;

// ── Evidence input (provided by caller) ─────────────────────

export const PatternResult = z.object({
  matched: z.number(),
  total: z.number(),
});
export type PatternResult = z.infer<typeof PatternResult>;

export const EvidenceInput = z.object({
  metrics: z.record(z.number()).optional(),
  pattern_results: z.record(PatternResult).optional(),
});
export type EvidenceInput = z.infer<typeof EvidenceInput>;

// ── Evaluation result ───────────────────────────────────────

export const ConstraintResult = z.object({
  constraint_id: z.string(),
  title: z.string(),
  dimension: Dimension,
  severity: Severity,
  satisfied: z.boolean().nullable(),
  actual_value: z.union([z.number(), z.string(), z.null()]).nullable(),
  expected: z.string(),
  message: z.string(),
});
export type ConstraintResult = z.infer<typeof ConstraintResult>;
