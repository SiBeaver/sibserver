import { toProposalView } from '@sibeaver/core';
import type { OperationContext, ProposalStatus, ProposalView } from '@sibeaver/core';

// 契约变更提案只读视图；重规划提案已退役，仅保留历史行可读
export async function listProposals(
  ctx: OperationContext,
  status?: ProposalStatus,
): Promise<ProposalView[]> {
  const records = await ctx.proposals.listProposals(status);
  return records.map(toProposalView);
}
