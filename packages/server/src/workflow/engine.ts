import type {
  OperationContext,
  WorkflowTemplateInput,
  WorkflowTemplateRecord,
  WorkflowTemplateView,
} from '@sibeaver/core';
import { WorkflowTemplateInput as WorkflowTemplateInputSchema, validateWorkflowContract } from '@sibeaver/core';

// 工作流模板薄壳（r-ea2b）
//
// 原生工作流文件是执行权威：本模块只登记引用、校验 contract 声明与门禁证据，
// 不解析执行逻辑、不运行 workflow、不新增调度。
// ============================================================

export interface WorkflowTemplateRegistration extends WorkflowTemplateView {
  /** 与上次登记的 sha256 相比是否变化（首次登记为 true） */
  changed: boolean;
}

// @sibom r-wt1a — 登记模板引用并返回 changed（sha256 是否相对上次登记变化）
// @sibom r-ea2b — sibeaver 持有模板引用、校验五类声明，不执行 workflow
export async function registerWorkflowTemplate(
  ctx: OperationContext,
  input: WorkflowTemplateInput,
  now: string = new Date().toISOString(),
): Promise<WorkflowTemplateRegistration> {
  const parsed = WorkflowTemplateInputSchema.parse(input);
  validateWorkflowContract(parsed.contract);
  const existing = await ctx.workflowTemplates.get(parsed.id);
  const record: WorkflowTemplateRecord = {
    ...parsed,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const saved = await ctx.workflowTemplates.upsert(record);
  return { ...saved, changed: existing === null || existing.sha256 !== parsed.sha256 };
}

export async function listWorkflowTemplates(ctx: OperationContext): Promise<WorkflowTemplateView[]> {
  return ctx.workflowTemplates.list();
}

export async function getWorkflowTemplate(
  ctx: OperationContext,
  id: string,
): Promise<WorkflowTemplateView | null> {
  return ctx.workflowTemplates.get(id);
}

export interface MissingGateEvidence {
  gate_id: string;
  evidence_source: string;
}

export interface WorkflowGateCheckResult {
  template_id: string;
  required_gates: number;
  /** 必需门禁引用的证据源是否都已上报（只核对存在，不判断证据内容） */
  evidence_present: boolean;
  missing: MissingGateEvidence[];
}

/** 门禁证据核对：必需门禁引用的证据源必须在账本中已上报（只核对存在，不解释语义） */
// @sibom r-wt3c — 必需门禁证据须已上报；只核对存在（evidencePresent），引用缺失按不通过
// @sibom r-ea2b — 校验模板门禁证据：只核对必需门禁的证据是否已上报
export async function checkWorkflowTemplateGates(
  ctx: OperationContext,
  id: string,
): Promise<WorkflowGateCheckResult | null> {
  const template = await ctx.workflowTemplates.get(id);
  if (!template) return null;

  const refById = new Map(template.contract.evidence_refs.map(ref => [ref.id, ref]));
  const required = template.contract.gates.filter(gate => gate.required !== false);
  const missing: MissingGateEvidence[] = [];
  for (const gate of required) {
    const ref = refById.get(gate.evidence_ref);
    if (!ref) {
      // 表被带外写入或 schema 收紧：fail-closed，计入缺失而不是跳过
      missing.push({ gate_id: gate.id, evidence_source: `(引用缺失：${gate.evidence_ref})` });
      continue;
    }
    const evidence = await ctx.gap.getEvidence(ref.source);
    if (!evidence) missing.push({ gate_id: gate.id, evidence_source: ref.source });
  }
  return {
    template_id: id,
    required_gates: required.length,
    evidence_present: missing.length === 0,
    missing,
  };
}
