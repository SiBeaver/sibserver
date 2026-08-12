import type { OperationContext } from '@sibeaver/core';
import type { RequirementNode } from '@sibeaver/core';

export interface AcceptanceGap {
  requirement_id: string;
  requirement_title: string;
  acceptance_type: string | null;
  total: number;
  satisfied: number;
  unsatisfied: number;
  gap_items: { id: string; label: string }[];
}

export async function evaluateAcceptanceGap(
  ctx: OperationContext,
  requirementId: string,
): Promise<AcceptanceGap> {
  const node = await ctx.nodes.getById(requirementId);
  if (!node || node.type !== 'requirement') {
    throw new Error(`需求不存在：${requirementId}`);
  }
  return computeGap(node as RequirementNode);
}

export async function evaluateAllAcceptanceGaps(
  ctx: OperationContext,
): Promise<AcceptanceGap[]> {
  const requirements = await ctx.nodes.getByType('requirement') as RequirementNode[];
  return requirements
    .filter(r => r.acceptance !== null)
    .map(computeGap);
}

function computeGap(req: RequirementNode): AcceptanceGap {
  const acceptance = req.acceptance;
  if (!acceptance || acceptance.type !== 'checklist') {
    return {
      requirement_id: req.id,
      requirement_title: req.title,
      acceptance_type: acceptance?.type ?? null,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
      gap_items: [],
    };
  }

  const items = acceptance.items;
  const gapItems = items
    .filter(i => !i.satisfied)
    .map(i => ({ id: i.id, label: i.label }));

  return {
    requirement_id: req.id,
    requirement_title: req.title,
    acceptance_type: 'checklist',
    total: items.length,
    satisfied: items.length - gapItems.length,
    unsatisfied: gapItems.length,
    gap_items: gapItems,
  };
}
