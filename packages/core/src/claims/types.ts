import { z } from 'zod';

// ============================================================
// 责任认领（claims）— 边界声明随认领提交（组织层/边界声明、认领与仲裁）
// 控制面只登记与校验，不派发、不指令、不中断。
// ============================================================

export const IsolationMode = z.enum(['worktree', 'workspace']);
export type IsolationMode = z.infer<typeof IsolationMode>;

export const ClaimDomain = z.enum(['build', 'runtime']);
export type ClaimDomain = z.infer<typeof ClaimDomain>;

export const FactType = z.enum([
  'code', 'artifact', 'contract',
  'service', 'host', 'config', 'runtime_contract',
]);
export type FactType = z.infer<typeof FactType>;

/** 域级事实类型由契约定义（r-bc2b）：构建域 / 运行域各自的可写事实类型 */
export const DOMAIN_FACT_TYPES: Record<ClaimDomain, readonly FactType[]> = {
  build: ['code', 'artifact', 'contract'],
  runtime: ['service', 'host', 'config', 'runtime_contract'],
};

/** 契约子树写入只提案、不直接生效（r-bc2b） */
export const PROPOSAL_ONLY_FACT_TYPES: readonly FactType[] = ['contract', 'runtime_contract'];

export const BoundaryFact = z.object({
  type: FactType,
  scopes: z.array(z.string().min(1)).min(1),
});
export type BoundaryFact = z.infer<typeof BoundaryFact>;

export const BoundaryDeclaration = z.object({
  fact_types: z.array(BoundaryFact).min(1),
  read_only: z.array(z.string()).default([]),
  escalation: z.array(z.string()).default([]),
});
export type BoundaryDeclaration = z.infer<typeof BoundaryDeclaration>;

export const PreAuthorization = z.object({
  autonomous_actions: z.array(z.string()).default([]),
  prohibited: z.array(z.string()).default([]),
  default_assumptions: z.array(z.string()).default([]),
  must_stop_conditions: z.array(z.string()).default([]),
});
export type PreAuthorization = z.infer<typeof PreAuthorization>;

export const SessionRef = z.object({
  host: z.string().min(1),
  workspace: z.string().min(1),
  native_id: z.string().optional(),
});
export type SessionRef = z.infer<typeof SessionRef>;

export const ClaimStatus = z.enum(['active', 'released', 'revoked', 'expired', 'failed']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const ClaimCreateInput = z.object({
  executor: z.string().min(1),
  requirement_keys: z.array(z.string().min(1)).min(1),
  domain: ClaimDomain.default('build'),
  boundary: BoundaryDeclaration,
  pre_authorization: PreAuthorization.optional(),
  isolation_mode: IsolationMode,
  isolation_id: z.string().min(1),
  session_ref: SessionRef.optional(),
});
export type ClaimCreateInput = z.infer<typeof ClaimCreateInput>;

export const ClaimRenewInput = z.object({
  executor: z.string().min(1),
});
export type ClaimRenewInput = z.infer<typeof ClaimRenewInput>;

export const ClaimReleaseInput = z.object({
  executor: z.string().min(1),
  reason: z.string().optional(),
});
export type ClaimReleaseInput = z.infer<typeof ClaimReleaseInput>;

export const ClaimRevokeInput = z.object({
  revoked_by: z.string().min(1),
  reason: z.string().min(1),
});
export type ClaimRevokeInput = z.infer<typeof ClaimRevokeInput>;

export const ClaimChangedFact = z.object({
  type: FactType.optional(),
  path: z.string().min(1),
});
export type ClaimChangedFact = z.infer<typeof ClaimChangedFact>;

export const ClaimReportInput = z.object({
  executor: z.string().min(1),
  changed_facts: z.array(ClaimChangedFact),
  incomplete_reason: z.string().optional(),
});
export type ClaimReportInput = z.infer<typeof ClaimReportInput>;

export const ClaimNarrowInput = z.object({
  executor: z.string().min(1),
  boundary: BoundaryDeclaration,
});
export type ClaimNarrowInput = z.infer<typeof ClaimNarrowInput>;

export const ResponsibilityClaim = z.object({
  id: z.string(),
  executor: z.string(),
  requirement_keys: z.array(z.string()),
  domain: ClaimDomain,
  baseline_commit: z.string(),
  boundary: BoundaryDeclaration,
  pre_authorization: PreAuthorization.nullable(),
  isolation_mode: IsolationMode,
  isolation_id: z.string(),
  session_ref: SessionRef.nullable(),
  status: ClaimStatus,
  lease_expires_at: z.string(),
  heartbeat_at: z.string(),
  created_at: z.string(),
  released_at: z.string().nullable(),
  revoked_reason: z.string().nullable(),
});
export type ResponsibilityClaim = z.infer<typeof ResponsibilityClaim>;
