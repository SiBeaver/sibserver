import { z } from 'zod';
import { GapKind } from '../gap/types.js';

// ============================================================
// 工作包 — 差距账本到执行面的派生单元（r-wp1a/r-wp2b）
// 派生视图，不承载执行状态；claim/lease 是唯一运行时状态。
// ============================================================

export const GapIdentity = z.object({
  requirement_key: z.string(),
  kind: GapKind,
  evidence_source: z.string(),
});
export type GapIdentity = z.infer<typeof GapIdentity>;

export const FactBoundary = z.object({
  writable: z.array(z.string()),
  status: z.enum(['derived', 'unresolved']),
  sources: z.array(z.string()),
});
export type FactBoundary = z.infer<typeof FactBoundary>;

export const WorkpackAcceptance = z.object({
  type: z.literal('gap-recompute'),
  requirement_keys: z.array(z.string()),
  gap_identities: z.array(GapIdentity),
});
export type WorkpackAcceptance = z.infer<typeof WorkpackAcceptance>;

export const BoundaryContract = z.object({
  responsibility: z.array(z.string()),
  contract_subtree: z.string(),
  fact_boundary: FactBoundary,
  acceptance: WorkpackAcceptance,
  escalation: z.array(z.string()),
});
export type BoundaryContract = z.infer<typeof BoundaryContract>;

export const WorkpackGap = z.object({
  requirement_key: z.string(),
  kind: GapKind,
  evidence_source: z.string(),
  title: z.string(),
  severity: z.string(),
});
export type WorkpackGap = z.infer<typeof WorkpackGap>;

export const Workpack = z.object({
  id: z.string(),
  baseline: z.string(),
  title: z.string(),
  requirement_keys: z.array(z.string()),
  gaps: z.array(WorkpackGap),
  deps: z.array(z.string()),
  blocked_by: z.array(z.string()),
  /** >=0 为可调度并行组；-1 依赖未满足；-2 事实边界未解析 */
  parallel_group: z.number().int(),
  boundary: BoundaryContract,
});
export type Workpack = z.infer<typeof Workpack>;

export const WorkpackSummary = z.object({
  total: z.number().int(),
  ready: z.number().int(),
  blocked: z.number().int(),
  unresolved_boundary: z.number().int(),
});
export type WorkpackSummary = z.infer<typeof WorkpackSummary>;

export const WorkpackList = z.object({
  baseline: z.string().nullable(),
  workpacks: z.array(Workpack),
  summary: WorkpackSummary,
});
export type WorkpackList = z.infer<typeof WorkpackList>;
