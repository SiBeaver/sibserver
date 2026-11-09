import { z } from 'zod';

// 工作流模板（r-ea2b）
//
// 原生工作流文件（Qoder workflow 脚本 / YAML）是执行权威；contract 块只承载
// 五类声明：工位、检查规格、门禁、证据引用、执行者类型。
// sibeaver 只持有引用、校验声明与门禁证据，不执行 workflow、不新增 DSL。
// ============================================================

export const WorkflowWorkstation = z.object({
  id: z.string().min(1),
  actor: z.string().min(1),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
});
export type WorkflowWorkstation = z.infer<typeof WorkflowWorkstation>;

export const WorkflowCheck = z.object({
  id: z.string().min(1),
  kind: z.enum(['mechanical', 'human']),
  evidence_ref: z.string().min(1),
  acceptance: z.string().optional(),
});
export type WorkflowCheck = z.infer<typeof WorkflowCheck>;

export const WorkflowGate = z.object({
  id: z.string().min(1),
  required: z.boolean().default(true),
  evidence_ref: z.string().min(1),
});
export type WorkflowGate = z.infer<typeof WorkflowGate>;

export const WorkflowEvidenceRef = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
});
export type WorkflowEvidenceRef = z.infer<typeof WorkflowEvidenceRef>;

export const WorkflowContract = z.object({
  executor_types: z.array(z.string().min(1)).min(1),
  workstations: z.array(WorkflowWorkstation).min(1),
  checks: z.array(WorkflowCheck).min(1),
  gates: z.array(WorkflowGate).min(1),
  evidence_refs: z.array(WorkflowEvidenceRef).min(1),
});
export type WorkflowContract = z.infer<typeof WorkflowContract>;

export const WorkflowTemplateInput = z.object({
  id: z.string().min(1),
  /** harness 名称（如 qoder-cli）；模板可移植，执行归 harness */
  harness: z.string().min(1),
  /** 原生格式（如 qoder-workflow / yaml） */
  format: z.string().min(1),
  path: z.string().min(1),
  commit: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contract: WorkflowContract,
});
export type WorkflowTemplateInput = z.infer<typeof WorkflowTemplateInput>;

export interface WorkflowTemplateRecord extends WorkflowTemplateInput {
  created_at: string;
  updated_at: string;
}

export type WorkflowTemplateView = WorkflowTemplateRecord;

function uniqueIds(label: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${label} ID 重复：${id}`);
    seen.add(id);
  }
}

/** 校验五类项内部唯一性与交叉引用；错误回显可用 ID（可自纠） */
// @sibom r-wt2b — contract 必含五类声明，项内 ID 唯一、检查/门禁引用必须存在，至少一个必需门禁
// @sibom r-ea2b — 模板 manifest 必含五类项；缺项即拒绝
export function validateWorkflowContract(contract: WorkflowContract): void {
  uniqueIds('工位', contract.workstations.map(w => w.id));
  uniqueIds('检查', contract.checks.map(c => c.id));
  uniqueIds('门禁', contract.gates.map(g => g.id));
  uniqueIds('证据引用', contract.evidence_refs.map(r => r.id));

  const refs = new Set(contract.evidence_refs.map(r => r.id));
  const available = [...refs].join(', ');
  for (const check of contract.checks) {
    if (!refs.has(check.evidence_ref)) {
      throw new Error(`检查「${check.id}」引用的证据「${check.evidence_ref}」不在 evidence_refs 中（可用：${available}）`);
    }
  }
  for (const gate of contract.gates) {
    if (!refs.has(gate.evidence_ref)) {
      throw new Error(`门禁「${gate.id}」引用的证据「${gate.evidence_ref}」不在 evidence_refs 中（可用：${available}）`);
    }
  }
  if (!contract.gates.some(gate => gate.required !== false)) {
    throw new Error('至少一个门禁必须是必需（required: true）——全可选门禁不构成门禁');
  }
}
