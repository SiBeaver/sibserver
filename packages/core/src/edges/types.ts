import { z } from 'zod';

// ============================================================
// 关系类型
// ============================================================

export const RelationType = z.enum([
  'decomposes_into',
  'spawns',
  'produces',
  'informs',
  'creates',
  'mitigates',
  'addresses',
  'blocks',
  'relates_to',
  'supersedes',
  'evidenced_by',
  'derived_from',
  'fulfills',
  'contradicts',
]);
export type RelationType = z.infer<typeof RelationType>;

// ============================================================
// 边 schema
// ============================================================

export const Edge = z.object({
  id: z.string(),
  source_id: z.string(),
  target_id: z.string(),
  relation: RelationType,
  weight: z.number().min(0).max(1).nullable().default(null),
  annotation: z.string().nullable().default(null),
  created_at: z.string().datetime(),
});
export type Edge = z.infer<typeof Edge>;

// ============================================================
// 关系约束注册表
// 定义每种关系类型允许的 源节点类型 → 目标节点类型
// ============================================================

import type { NodeType } from '../nodes/types.js';

type RelationConstraint = {
  source: NodeType[];
  target: NodeType[];
};

export const RELATION_CONSTRAINTS: Record<RelationType, RelationConstraint> = {
  decomposes_into: {
    source: ['witem', 'requirement'],
    target: ['witem', 'requirement'],
  },
  spawns: {
    source: [],
    target: [],
  },
  produces: {
    source: [],
    target: ['decision', 'knowledge', 'artifact'],
  },
  informs: {
    source: ['knowledge', 'decision', 'requirement'],
    target: ['decision', 'witem'],
  },
  creates: {
    source: ['decision'],
    target: ['tech_debt', 'risk'],
  },
  mitigates: {
    source: ['decision'],
    target: ['risk'],
  },
  addresses: {
    source: ['decision'],
    target: ['tech_debt'],
  },
  blocks: {
    source: ['risk', 'tech_debt', 'requirement'],
    target: ['witem'],
  },
  relates_to: {
    source: ['witem', 'decision', 'risk', 'tech_debt', 'artifact', 'knowledge', 'requirement'],
    target: ['witem', 'decision', 'risk', 'tech_debt', 'artifact', 'knowledge', 'requirement'],
  },
  supersedes: {
    source: ['decision', 'knowledge', 'requirement'],
    target: ['decision', 'knowledge', 'requirement'],
  },
  evidenced_by: {
    source: ['knowledge', 'decision', 'requirement'],
    target: ['artifact'],
  },
  derived_from: {
    source: ['witem'],
    target: ['knowledge'],
  },
  fulfills: {
    source: ['witem'],
    target: ['requirement'],
  },
  contradicts: {
    source: ['knowledge'],
    target: ['requirement'],
  },
};

export function validateRelation(
  relation: RelationType,
  sourceType: NodeType,
  targetType: NodeType,
): boolean {
  const constraint = RELATION_CONSTRAINTS[relation];
  return (
    constraint.source.includes(sourceType) &&
    constraint.target.includes(targetType)
  );
}
