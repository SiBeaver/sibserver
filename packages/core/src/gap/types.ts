import { z } from 'zod';
import { Constraint } from '../constraints/types.js';

// ============================================================
// Gap 检测 — 三方对账类型
//
// 对账是纯函数：gap = f(BOM@commit, 证据集, 在办 witem)。
// BOM 快照随基准上报（sibs server 不扫工作区），gap 账本是派生账。
// ============================================================

export const GapKind = z.enum(['violation', 'absence', 'staleness']);
export type GapKind = z.infer<typeof GapKind>;

export const GapRowStatus = z.enum(['open', 'resolved', 'superseded']);
export type GapRowStatus = z.infer<typeof GapRowStatus>;

// ── BOM 快照（基准上报载荷）─────────────────────────────────

export const BomRule = z.object({
  id: z.string(),
  title: z.string(),
});
export type BomRule = z.infer<typeof BomRule>;

export const BomRequirement = z.object({
  key: z.string(),
  title: z.string(),
  rules: z.array(BomRule).default([]),
  /** 需求依赖（跨域已规范化为 domain/req）；缺省视为无依赖 */
  deps: z.array(z.string()).optional(),
});
export type BomRequirement = z.infer<typeof BomRequirement>;

export const BomConstraint = Constraint.extend({
  requirement_key: z.string().optional(),
});
export type BomConstraint = z.infer<typeof BomConstraint>;

export const BomSnapshot = z.object({
  commit: z.string(),
  requirements: z.array(BomRequirement).default([]),
  constraints: z.array(BomConstraint).default([]),
});
export type BomSnapshot = z.infer<typeof BomSnapshot>;

// 分区上报载荷：requirements/constraints 可缺省——缺省分区沿用旧基线值；
// 首次上报（无旧基线）时缺任一分区由引擎拒绝（400）。
export const BomBaselineInput = z.object({
  commit: z.string(),
  requirements: z.array(BomRequirement).optional(),
  constraints: z.array(BomConstraint).optional(),
});
export type BomBaselineInput = z.infer<typeof BomBaselineInput>;

// ── 账本行 ──────────────────────────────────────────────────

export interface GapRowRecord {
  id: string;
  requirement_key: string;
  kind: GapKind;
  title: string;
  detail: string;
  severity: string;
  source_ref: string;
  /** 身份三元组之证据源——constraint:{id} / sibom-tags:{ruleId} / @bom:{key} / @sibom:{ruleId} / node:{id} / witem:{id} */
  evidence_source: string;
  bom_commit: string;
  condition_fingerprint: string;
  evidence_fingerprint: string | null;
  status: GapRowStatus;
  detected_at: string;
  resolved_at: string | null;
  superseded_at: string | null;
}

// ── 证据（上报的资产）────────────────────────────────────────
// source_id 约定：
//   constraint:{constraintId}          → { matched, total } 或 { value }
//   bom-tags                           → { tags: [{ key, file }] }（@bom 需求键认领）
//   sibom-tags                         → { rules: [{ id, file }] }（@sibom 规则认领）

export const EvidenceItemInput = z.object({
  source_id: z.string(),
  payload: z.unknown(),
  reported_at: z.string().optional(),
  /** 观测对照的基线 commit（r-el3c）；缺省取当前基线 */
  baseline_commit: z.string().optional(),
});
export type EvidenceItemInput = z.infer<typeof EvidenceItemInput>;

/** 证据上报载荷（r-gl5e）：constraints 分区先并入基线再重算 */
export const EvidenceReportInput = z.object({
  items: z.array(EvidenceItemInput),
  constraints: z.array(BomConstraint).optional(),
  commit: z.string().optional(),
});
export type EvidenceReportInput = z.infer<typeof EvidenceReportInput>;

export interface EvidenceRecord {
  source_id: string;
  payload: unknown;
  fingerprint: string;
  reported_at: string;
  baseline_commit: string | null;
}

/** gap_evidence_log 行（append-only 留痕，r-el3c） */
export interface EvidenceLogRecord {
  id: number;
  source_id: string;
  payload: unknown;
  fingerprint: string;
  reported_at: string;
  baseline_commit: string | null;
  created_at: string;
}

// ── 豁免 ────────────────────────────────────────────────────

export const WaiverInput = z.object({
  fingerprint: z.string(),
  reason: z.string(),
  expires_at: z.string().nullable().optional(),
});
export type WaiverInput = z.infer<typeof WaiverInput>;

export interface WaiverRecord {
  fingerprint: string;
  reason: string;
  expires_at: string | null;
  created_at: string;
}

// ── 账单视图（读账本）────────────────────────────────────────

export interface GapView extends GapRowRecord {
  in_progress_witem: { id: string; title: string } | null;
  waiver: { reason: string; expires_at: string | null } | null;
  /** 该行对应证据的上报时间——账单展示证据年龄；无证据行为 null */
  evidence_reported_at: string | null;
}

// ── 对照视图证据结构（AI 对照降级为目检，不产差距条目）────────

export interface EvidenceScene {
  requirement_key: string;
  files: Array<{ path: string; bom_tag: string | null }>;
  runs: Array<{ label: string; result: 'pass' | 'fail'; reported_at: string }>;
  sibs_nodes: Array<{ id: string; type: string; title: string }>;
}
