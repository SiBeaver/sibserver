import { z } from 'zod';
import { Constraint } from '../constraints/types.js';
import { Priority } from '../nodes/types.js';

// ============================================================
// Gap 检测 — 三方对账类型
//
// 对账是纯函数：gap = f(BOM@commit, 证据集, 在办 goal)。
// BOM 快照随基准上报（sibs server 不扫工作区），gap 账本是派生账。
// ============================================================

export const GapKind = z.enum(['violation', 'absence', 'staleness']);
export type GapKind = z.infer<typeof GapKind>;

export const GapRowStatus = z.enum(['open', 'resolved', 'superseded']);
export type GapRowStatus = z.infer<typeof GapRowStatus>;

// ── BOM 快照（基准上报载荷）─────────────────────────────────

export const BomAcceptanceItem = z.object({
  id: z.string(),
  label: z.string(),
});
export type BomAcceptanceItem = z.infer<typeof BomAcceptanceItem>;

export const BomRequirement = z.object({
  key: z.string(),
  title: z.string(),
  priority: Priority.default('medium'),
  acceptance: z.array(BomAcceptanceItem).default([]),
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

// ── 账本行 ──────────────────────────────────────────────────

export interface GapRowRecord {
  id: string;
  requirement_key: string;
  kind: GapKind;
  title: string;
  detail: string;
  severity: string;
  source_ref: string;
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
//   acceptance:{requirementKey}#{itemId} → { passed, detail? }
//   bom-tags                            → { tags: [{ key, file }] }

export const EvidenceItemInput = z.object({
  source_id: z.string(),
  payload: z.unknown(),
  reported_at: z.string().optional(),
});
export type EvidenceItemInput = z.infer<typeof EvidenceItemInput>;

export interface EvidenceRecord {
  source_id: string;
  payload: unknown;
  fingerprint: string;
  reported_at: string;
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
  in_progress_goal: { id: string; title: string } | null;
  waiver: { reason: string; expires_at: string | null } | null;
}
