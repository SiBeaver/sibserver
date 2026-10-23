import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../core/tests/helpers/test-db.js';
import { OperationContext } from '@sibeaver/core';
import type { BomSnapshot, GapRowRecord, Workpack } from '@sibeaver/core';
import { listWorkpacks } from '../src/workpack/engine.js';

const NOW = '2026-08-20T00:00:00.000Z';

function bom(): BomSnapshot {
  return {
    commit: 'b1',
    requirements: [
      { key: 'dom/a', title: '需求A', rules: [{ id: 'r-aaaa', title: '规则A' }], deps: [] },
      { key: 'dom/b', title: '需求B', rules: [{ id: 'r-bbbb', title: '规则B' }], deps: ['dom/a'] },
      { key: 'dom/c', title: '需求C', rules: [{ id: 'r-cccc', title: '规则C' }], deps: [] },
      { key: 'dom/d', title: '需求D', rules: [{ id: 'r-dddd', title: '规则D' }], deps: [] },
      { key: 'dom/e', title: '需求E', rules: [{ id: 'r-eeee', title: '规则E' }], deps: [] },
    ],
    constraints: [
      {
        id: 'c-a', title: 'A 范围', dimension: 'security', severity: 'critical', description: '',
        condition: { evidence_type: 'code_pattern', scope: 'src/a/', pattern: 'auth', operator: 'present' },
        requirement_key: 'dom/a',
      },
      {
        id: 'c-c', title: 'C 范围', dimension: 'quality', severity: 'medium', description: '',
        condition: { evidence_type: 'code_pattern', scope: 'src/c/', pattern: 'test', operator: 'present' },
        requirement_key: 'dom/c',
      },
      {
        id: 'c-d', title: 'D 共享范围', dimension: 'quality', severity: 'medium', description: '',
        condition: { evidence_type: 'code_pattern', scope: 'src/a/shared/', pattern: 'flag', operator: 'present' },
        requirement_key: 'dom/d',
      },
    ],
  };
}

function gapRow(
  id: string,
  requirementKey: string,
  kind: GapRowRecord['kind'],
  evidenceSource: string,
): GapRowRecord {
  return {
    id,
    requirement_key: requirementKey,
    kind,
    title: `${requirementKey} gap`,
    detail: '',
    severity: 'medium',
    source_ref: evidenceSource,
    evidence_source: evidenceSource,
    bom_commit: 'b1',
    condition_fingerprint: `cf-${id}`,
    evidence_fingerprint: null,
    status: 'open',
    detected_at: NOW,
    resolved_at: null,
    superseded_at: null,
  };
}

function find(workpacks: Workpack[], key: string): Workpack {
  const found = workpacks.find(wp => wp.requirement_keys[0] === key);
  if (!found) throw new Error(`workpack not found: ${key}`);
  return found;
}

describe('工作包派生', () => {
  let ctx: OperationContext;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    ctx = new OperationContext(t.sql, 'default');
    close = t.close;
    await ctx.gap.setBaseline(bom(), NOW);
    await ctx.gap.upsertEvidence({
      source_id: 'sibom-tags',
      payload: { rules: [{ id: 'r-aaaa', file: 'src/a/file.ts' }] },
      fingerprint: 'fp-sibom',
      reported_at: NOW,
      baseline_commit: 'b1',
    });
    const rows: GapRowRecord[] = [
      gapRow('g-a', 'dom/a', 'absence', 'sibom-tags:r-aaaa'),
      gapRow('g-b', 'dom/b', 'absence', 'sibom-tags:r-bbbb'),
      gapRow('g-c', 'dom/c', 'absence', 'sibom-tags:r-cccc'),
      gapRow('g-d', 'dom/d', 'absence', 'sibom-tags:r-dddd'),
      gapRow('g-e', 'dom/e', 'absence', 'sibom-tags:r-eeee'),
    ];
    for (const row of rows) await ctx.gap.insertRow(row);
  });

  afterEach(async () => { await close(); });

  it('按需求键聚拢差距，派生边界契约、依赖与并行组', async () => {
    const result = await listWorkpacks(ctx);
    expect(result.baseline).toBe('b1');
    expect(result.summary).toEqual({ total: 5, ready: 3, blocked: 1, unresolved_boundary: 2 });

    const a = find(result.workpacks, 'dom/a');
    expect(a.boundary.responsibility).toEqual(['dom/a']);
    expect(a.boundary.fact_boundary.status).toBe('derived');
    expect(a.boundary.fact_boundary.writable).toEqual(['src/a/', 'src/a/file.ts']);
    expect(a.boundary.fact_boundary.sources).toEqual(['constraint:c-a', 'sibom-tags']);
    expect(a.boundary.acceptance.gap_identities).toEqual([
      { requirement_key: 'dom/a', kind: 'absence', evidence_source: 'sibom-tags:r-aaaa' },
    ]);
    expect(a.parallel_group).toBe(0);

    const b = find(result.workpacks, 'dom/b');
    expect(b.deps).toEqual(['dom/a']);
    expect(b.blocked_by).toEqual(['dom/a']);
    expect(b.parallel_group).toBe(-1);
    expect(b.boundary.fact_boundary.status).toBe('unresolved');

    const c = find(result.workpacks, 'dom/c');
    expect(c.boundary.fact_boundary.writable).toEqual(['src/c/']);
    expect(c.parallel_group).toBe(0);

    const d = find(result.workpacks, 'dom/d');
    expect(d.boundary.fact_boundary.writable).toEqual(['src/a/shared/']);
    expect(d.parallel_group).toBe(1);

    const e = find(result.workpacks, 'dom/e');
    expect(e.boundary.fact_boundary.status).toBe('unresolved');
    expect(e.parallel_group).toBe(-2);
  });

  it('工作包身份稳定，责任差距变化即产生新身份', async () => {
    const first = find((await listWorkpacks(ctx)).workpacks, 'dom/a');
    const second = find((await listWorkpacks(ctx)).workpacks, 'dom/a');
    expect(first.id).toBe(second.id);

    await ctx.gap.insertRow(gapRow('g-a2', 'dom/a', 'violation', 'constraint:c-a'));
    const changed = find((await listWorkpacks(ctx)).workpacks, 'dom/a');
    expect(changed.id).not.toBe(first.id);
    expect(changed.gaps).toHaveLength(2);
  });

  it('无基线时返回空工作包集', async () => {
    const t = await createTestDb();
    const emptyCtx = new OperationContext(t.sql, 'default');
    try {
      expect(await listWorkpacks(emptyCtx)).toEqual({
        baseline: null,
        workpacks: [],
        summary: { total: 0, ready: 0, blocked: 0, unresolved_boundary: 0 },
      });
    } finally {
      await t.close();
    }
  });
});
