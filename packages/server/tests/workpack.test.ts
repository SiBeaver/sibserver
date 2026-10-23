import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../core/tests/helpers/test-db.js';
import { OperationContext } from '@sibeaver/core';
import type { BomSnapshot, GapRowRecord, Workpack } from '@sibeaver/core';
import {
  claimWorkpack, listWorkpacks, narrowWorkpackBoundary,
  releaseWorkpack, renewWorkpack, reportWorkpack, WorkpackError,
} from '../src/workpack/engine.js';

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

describe('工作包认领与边界执行', () => {
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

  async function workpackOf(key: string) {
    return find((await listWorkpacks(ctx)).workpacks, key);
  }

  it('未解析边界、被依赖阻塞与重复认领都被拒绝', async () => {
    const e = await workpackOf('dom/e');
    await expect(claimWorkpack(ctx, e.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-e',
    })).rejects.toMatchObject({ status: 409 });

    const b = await workpackOf('dom/b');
    await expect(claimWorkpack(ctx, b.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-b',
    })).rejects.toMatchObject({ status: 409 });

    const a = await workpackOf('dom/a');
    const first = await claimWorkpack(ctx, a.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-a',
    });
    const again = await claimWorkpack(ctx, a.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-a',
    });
    expect(again.claim.id).toBe(first.claim.id);
    await expect(claimWorkpack(ctx, a.id, {
      executor: 'e2', isolation_mode: 'worktree', isolation_id: 'wt-a2',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('workspace 串行、worktree 按事实边界相交裁决', async () => {
    const a = await workpackOf('dom/a');
    const c = await workpackOf('dom/c');
    const d = await workpackOf('dom/d');

    await claimWorkpack(ctx, a.id, {
      executor: 'e1', isolation_mode: 'workspace', isolation_id: 'shared',
    });
    await expect(claimWorkpack(ctx, c.id, {
      executor: 'e2', isolation_mode: 'workspace', isolation_id: 'shared',
    })).rejects.toMatchObject({ status: 409 });

    const cClaim = await claimWorkpack(ctx, c.id, {
      executor: 'e2', isolation_mode: 'worktree', isolation_id: 'wt-c',
    });
    expect(cClaim.claim.isolation_mode).toBe('worktree');

    await expect(claimWorkpack(ctx, d.id, {
      executor: 'e3', isolation_mode: 'worktree', isolation_id: 'wt-d',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('续租、释放与过期回收', async () => {
    const a = await workpackOf('dom/a');
    const first = await claimWorkpack(ctx, a.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-a',
    });
    const renewed = await renewWorkpack(ctx, a.id, { executor: 'e1' });
    expect(renewed.lease_expires_at >= first.claim.lease_expires_at).toBe(true);
    await releaseWorkpack(ctx, a.id, { executor: 'e1' });
    expect(await ctx.workpacks.getActiveClaimByWorkpack(a.id)).toBeNull();

    const second = await claimWorkpack(ctx, a.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-a',
    });
    await ctx.workpacks.updateClaimLease(
      second.claim.id,
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    );
    const third = await claimWorkpack(ctx, a.id, {
      executor: 'e2', isolation_mode: 'worktree', isolation_id: 'wt-a2',
    });
    expect(third.claim.id).not.toBe(second.claim.id);
    expect(third.claim.executor).toBe('e2');
  });

  it('越界上报判失败并留下证据；边界内上报保持认领', async () => {
    const a = await workpackOf('dom/a');
    await claimWorkpack(ctx, a.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-a',
    });

    const outside = await reportWorkpack(ctx, a.id, {
      executor: 'e1', changed_files: ['src/b/other.ts'],
    });
    expect(outside.ok).toBe(false);
    expect(outside.out_of_scope).toEqual(['src/b/other.ts']);
    expect(await ctx.workpacks.getActiveClaimByWorkpack(a.id)).toBeNull();
    expect(await ctx.gap.getEvidence(`workpack:${a.id}`)).not.toBeNull();

    await claimWorkpack(ctx, a.id, {
      executor: 'e2', isolation_mode: 'worktree', isolation_id: 'wt-a2',
    });
    const inside = await reportWorkpack(ctx, a.id, {
      executor: 'e2', changed_files: ['src/a/file.ts'],
    });
    expect(inside.ok).toBe(true);
    expect(await ctx.workpacks.getActiveClaimByWorkpack(a.id)).not.toBeNull();
  });

  it('边界只能收窄，放宽被拒绝', async () => {
    const a = await workpackOf('dom/a');
    await claimWorkpack(ctx, a.id, {
      executor: 'e1', isolation_mode: 'worktree', isolation_id: 'wt-a',
    });

    const narrowed = await narrowWorkpackBoundary(ctx, a.id, {
      executor: 'e1', writable: ['src/a/file.ts'],
    });
    expect(narrowed.boundary.fact_boundary.writable).toEqual(['src/a/file.ts']);

    await expect(narrowWorkpackBoundary(ctx, a.id, {
      executor: 'e1', writable: ['src/'],
    })).rejects.toMatchObject({ status: 409 });

    const outside = await reportWorkpack(ctx, a.id, {
      executor: 'e1', changed_files: ['src/a/shared/other.ts'],
    });
    expect(outside.ok).toBe(false);
  });
});
