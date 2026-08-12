import { sibs } from '../../sibs-client.js';
import type { ApiEvent } from '../../api-types.js';
import { saveRun, updateRun, type WorkflowRun } from '@sibeaver/core';
import { runGovernance } from '../governance.js';
import { decomposeRequirement } from '../decompose.js';

export async function handleRequirementAccepted(event: ApiEvent): Promise<void> {
  const diff = event.diff ?? [];
  const statusChange = diff.find((d) => d.field === "status");
  if (!statusChange || statusChange.newValue !== "accepted") return;

  const requirementId = event.nodeId;
  if (!requirementId) return;

  console.log(`[RequirementTrigger] requirement ${requirementId.slice(0, 8)} accepted, starting workflow`);

  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run: WorkflowRun = {
    id: runId,
    status: "queued",
    requirementId,
    template: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveRun(run);

  try {
    // Phase 0: Governance
    const gov = await runGovernance(requirementId);
    if (!gov.passed) {
      console.log(`[RequirementTrigger] governance failed:`, gov.issues);
      await sibs.updateRequirementStatus({
        requirementId,
        newStatus: "revision_needed",
        reason: `治理检查未通过: ${gov.issues.join("; ")}`,
      });
      updateRun(runId, { status: "failed", error: `governance: ${gov.issues.join("; ")}` });
      return;
    }

    // Transition to in_execution
    await sibs.updateRequirementStatus({
      requirementId,
      newStatus: "in_execution",
      reason: "治理通过，开始执行",
    });
    updateRun(runId, { status: "running" });

    // Phase 1: Decompose
    const { goalId } = await decomposeRequirement(requirementId);
    console.log(`[RequirementTrigger] decomposed into goal=${goalId.slice(0, 8)}`);

    updateRun(runId, {
      status: "succeeded",
      result: { goalId, message: "分解完成" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[RequirementTrigger] error:`, msg);
    updateRun(runId, { status: "failed", error: msg });
  }
}
