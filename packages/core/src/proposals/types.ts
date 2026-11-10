import { z } from 'zod';

// ============================================================
// 契约变更提案 — 只承载摘要、需求键与 BOM/git 引用
// ============================================================

/** replan 为遗留只读类型：工作包重规划已退役，不再新增 */
export const ProposalKind = z.enum(['contract', 'replan']);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const ProposalStatus = z.enum(['proposed', 'confirmed', 'superseded']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

// 提案正文不入控制面：只存 BOM/git 引用（决策 01M6ZGNQHVDFCDZ0T43N4EWJD9）
// @sibom r-ar7g — 契约提案只存摘要、需求键与 BOM/git 引用；正文不入控制面
export const ProposalRef = z.object({
  path: z.string().min(1),
  commit: z.string().min(1),
}).strict();
export type ProposalRef = z.infer<typeof ProposalRef>;

export const ProposalView = z.object({
  id: z.string(),
  claim_id: z.string().nullable(),
  kind: ProposalKind,
  proposer: z.string(),
  requirement_keys: z.array(z.string()),
  summary: z.string(),
  refs: z.array(ProposalRef),
  status: ProposalStatus,
  created_at: z.string(),
  confirmed_commit: z.string().nullable(),
  confirmed_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
});
export type ProposalView = z.infer<typeof ProposalView>;

export const ContractProposalInput = z.object({
  proposer: z.string().min(1),
  summary: z.string().min(1).max(2000),
  requirement_keys: z.array(z.string().min(1)).min(1),
  refs: z.array(ProposalRef).min(1),
}).strict();
export type ContractProposalInput = z.infer<typeof ContractProposalInput>;
