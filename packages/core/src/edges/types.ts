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

/** 可写入的节点类型；risk 为遗留类型，仅在兼容关系中保留 */
const WRITABLE_NODE_TYPES: NodeType[] = [
  'witem', 'decision', 'knowledge', 'requirement', 'artifact', 'tech_debt',
];

export const RELATION_CONSTRAINTS: Record<RelationType, RelationConstraint> = {
  decomposes_into: {
    source: ['witem', 'requirement'],
    target: ['witem', 'requirement'],
  },
  spawns: {
    source: ['decision'],
    target: ['witem'],
  },
  produces: {
    source: ['witem', 'decision'],
    target: ['knowledge', 'artifact'],
  },
  informs: {
    source: ['knowledge', 'decision', 'requirement'],
    target: ['decision', 'witem'],
  },
  // risk 为遗留节点类型：creates 由 record_decision 直接写入，兼容保留（决策 01M70DKNE4YEWSPAS423TDX8YC）
  creates: {
    source: ['decision'],
    target: ['tech_debt', 'risk'],
  },
  // 已退役关系：保留类型以读取历史边，不允许新写入（r-gm2b；退役决策 01M70E430RMT5YYMC7TVHRJKVW）
  mitigates: {
    source: [],
    target: [],
  },
  addresses: {
    source: ['decision'],
    target: ['tech_debt'],
  },
  // risk 为遗留节点类型：identify_risk 校验需要，兼容保留（决策 01M70DKNE4YEWSPAS423TDX8YC）
  blocks: {
    source: ['requirement', 'witem', 'decision', 'tech_debt', 'risk'],
    target: ['witem'],
  },
  relates_to: {
    source: WRITABLE_NODE_TYPES,
    target: WRITABLE_NODE_TYPES,
  },
  supersedes: {
    source: ['decision', 'knowledge', 'requirement'],
    target: ['decision', 'knowledge', 'requirement'],
  },
  evidenced_by: {
    source: ['knowledge', 'decision', 'requirement', 'witem'],
    target: ['artifact'],
  },
  derived_from: {
    source: WRITABLE_NODE_TYPES,
    target: WRITABLE_NODE_TYPES,
  },
  fulfills: {
    source: ['witem'],
    target: ['requirement'],
  },
  // 已退役关系：矛盾由检索侧检测，不进入写入边（r-gm2b；退役决策 01M70E430RMT5YYMC7TVHRJKVW）
  contradicts: {
    source: [],
    target: [],
  },
};

export function validateRelation(
  relation: RelationType,
  sourceType: NodeType,
  targetType: NodeType,
): boolean {
  const constraint = RELATION_CONSTRAINTS[relation];
  const endpointsAllowed =
    constraint.source.includes(sourceType) &&
    constraint.target.includes(targetType);
  // supersedes 必须同类型：decision→decision / knowledge→knowledge / requirement→requirement
  if (relation === 'supersedes') return endpointsAllowed && sourceType === targetType;
  return endpointsAllowed;
}

/** 关系允许的源/目标节点类型集合（单点真值，供拒绝文案复用） */
export function describeRelationTypes(relation: RelationType): string {
  const { source, target } = RELATION_CONSTRAINTS[relation];
  const list = (types: NodeType[]): string => (types.length > 0 ? types.join(', ') : '（无）');
  return `允许的源类型：[${list(source)}]，允许的目标类型：[${list(target)}]`;
}

/** 关系拒绝的自纠判据（r-mp5e）：回显该关系允许的源/目标节点类型集合 */
// @sibom r-mp5e — 关系拒绝回显该关系允许的源/目标类型集合
export function describeRelationRejection(
  relation: RelationType,
  sourceType: NodeType,
  targetType: NodeType,
): string {
  return `无效关系「${relation}」：${sourceType} → ${targetType}；${describeRelationTypes(relation)}`;
}
