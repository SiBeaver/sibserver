import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../core/tests/helpers/test-db.js';
import { OperationContext } from '@sibeaver/core';
import {
  checkWorkflowTemplateGates, getWorkflowTemplate, listWorkflowTemplates, registerWorkflowTemplate,
} from '../src/workflow/engine.js';

// ============================================================
// 工作流模板薄壳（r-ea2b）：只登记引用 + 校验 contract 与门禁证据
// ============================================================

describe('工作流模板薄壳', () => {
  let ctx: OperationContext;
  let close: () => void;

  beforeEach(async () => {
    const db = await createTestDb();
    ctx = new OperationContext(db.sql, 'default');
    close = db.close;
    await db.sql`DELETE FROM workflow_templates`;
  });

  afterEach(async () => { await close(); });

  function templateInput(overrides: Record<string, unknown> = {}) {
    return {
      id: 'wf-1',
      harness: 'qoder-cli',
      format: 'qoder-workflow',
      path: 'workflows/x.js',
      commit: 'abc1234',
      sha256: 'a'.repeat(64),
      contract: {
        executor_types: ['harness'],
        workstations: [
          { id: 'plan', actor: 'agent', inputs: ['in'], outputs: ['out'] },
        ],
        checks: [
          { id: 'gap-recompute', kind: 'mechanical', evidence_ref: 'gap-ledger' },
        ],
        gates: [
          { id: 'review', required: true, evidence_ref: 'review-report' },
          { id: 'optional', required: false, evidence_ref: 'optional-report' },
        ],
        evidence_refs: [
          { id: 'gap-ledger', source: 'gap-recompute' },
          { id: 'review-report', source: 'review-report' },
          { id: 'optional-report', source: 'optional-report' },
        ],
      },
      ...overrides,
    } as never;
  }

  it('登记模板并保留五类声明；重复登记更新引用但保留创建时间', async () => {
    const first = await registerWorkflowTemplate(ctx, templateInput());
    expect(first.contract.workstations).toHaveLength(1);
    expect(first.created_at).toBeTruthy();
    expect(first.changed).toBe(true);

    const same = await registerWorkflowTemplate(ctx, templateInput());
    expect(same.changed).toBe(false);

    const second = await registerWorkflowTemplate(ctx, templateInput({ sha256: 'b'.repeat(64) }), '2026-11-09T00:00:00.000Z');
    expect(second.sha256).toBe('b'.repeat(64));
    expect(second.changed).toBe(true);
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBe('2026-11-09T00:00:00.000Z');

    const list = await listWorkflowTemplates(ctx);
    expect(list.map(item => item.id)).toEqual(['wf-1']);
  });

  it('缺五类项或 sha256 非法时拒绝', async () => {
    const missingGates = templateInput() as { contract: Record<string, unknown> };
    delete missingGates.contract.gates;
    await expect(registerWorkflowTemplate(ctx, missingGates as never)).rejects.toThrow();

    await expect(registerWorkflowTemplate(ctx, templateInput({ sha256: 'not-a-sha' }))).rejects.toThrow();
  });

  it('全部门禁为可选时拒绝（空门禁不成立）', async () => {
    const input = templateInput();
    input.contract.gates = [{ id: 'review', required: false, evidence_ref: 'review-report' }];
    await expect(registerWorkflowTemplate(ctx, input))
      .rejects.toThrow(/至少一个门禁必须是必需（required: true）/);
  });

  it('检查/门禁引用未知 evidence_ref 时拒绝并回显可用 ID', async () => {
    const input = templateInput();
    input.contract.checks[0].evidence_ref = 'missing-ref';
    await expect(registerWorkflowTemplate(ctx, input))
      .rejects.toThrow(/检查「gap-recompute」引用的证据「missing-ref」不在 evidence_refs 中（可用：gap-ledger, review-report, optional-report）/);
  });

  it('同一类项内 ID 重复时拒绝', async () => {
    const input = templateInput();
    input.contract.workstations.push({ id: 'plan', actor: 'agent', inputs: [], outputs: [] });
    await expect(registerWorkflowTemplate(ctx, input)).rejects.toThrow(/工位 ID 重复：plan/);
  });

  it('门禁证据核对：必需门禁缺证据时不通过，上报后通过；可选门禁不参与', async () => {
    await registerWorkflowTemplate(ctx, templateInput());
    const before = await checkWorkflowTemplateGates(ctx, 'wf-1');
    expect(before?.required_gates).toBe(1);
    expect(before?.evidence_present).toBe(false);
    expect(before?.missing).toEqual([{ gate_id: 'review', evidence_source: 'review-report' }]);

    await ctx.gap.upsertEvidence({
      source_id: 'review-report',
      payload: { verdict: 'pass' },
      fingerprint: 'fp-review',
      reported_at: '2026-11-09T00:00:00.000Z',
      baseline_commit: null,
    });

    const after = await checkWorkflowTemplateGates(ctx, 'wf-1');
    expect(after?.evidence_present).toBe(true);
    expect(after?.missing).toEqual([]);
  });

  it('模板不存在时返回 null', async () => {
    expect(await getWorkflowTemplate(ctx, 'nope')).toBeNull();
    expect(await checkWorkflowTemplateGates(ctx, 'nope')).toBeNull();
  });
});
