import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../core/tests/helpers/test-db.js';
import { OperationContext } from '@sibeaver/core';
import type { BomSnapshot, BoundaryDeclaration, ClaimCreateInput, Sql } from '@sibeaver/core';
import {
  ClaimError, createClaim, getClaim, listClaims, narrowClaimBoundary,
  proposeClaimContractChange, releaseClaim, renewClaim, reportClaim, revokeClaim,
} from '../src/claims/engine.js';
import { setBaseline } from '../src/gap/engine.js';

const NOW = '2026-08-20T00:00:00.000Z';

function bom(): BomSnapshot {
  return {
    commit: 'b1',
    requirements: [
      { key: 'dom/a', title: '需求A', rules: [{ id: 'r-aaaa', title: '规则A' }], deps: [] },
      { key: 'dom/b', title: '需求B', rules: [{ id: 'r-bbbb', title: '规则B' }], deps: [] },
      { key: 'dom/c', title: '需求C', rules: [{ id: 'r-cccc', title: '规则C' }], deps: [] },
    ],
    draft_requirements: [],
  };
}

function boundary(code: string[], contract: string[] = []): BoundaryDeclaration {
  const factTypes: BoundaryDeclaration['fact_types'] = [{ type: 'code', scopes: code }];
  if (contract.length > 0) factTypes.push({ type: 'contract', scopes: contract });
  return { fact_types: factTypes, read_only: [], escalation: [] };
}

function claimInput(executor: string, keys: string[], declared: BoundaryDeclaration): ClaimCreateInput {
  return {
    executor,
    requirement_keys: keys,
    domain: 'build',
    boundary: declared,
    isolation_mode: 'worktree',
    isolation_id: `${executor}-wt`,
    pre_authorization: {
      autonomous_actions: ['run tests', 'edit code'],
      prohibited: ['push'],
      default_assumptions: ['deps installed'],
      must_stop_conditions: ['contract change'],
    },
    session_ref: { host: 'host-1', workspace: '/repo', native_id: 'sess-1' },
  };
}

describe('责任认领（claims）', () => {
  let ctx: OperationContext;
  let sql: Sql;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    ctx = new OperationContext(t.sql, 'default');
    sql = t.sql;
    close = t.close;
    await ctx.gap.setBaseline(bom(), NOW);
  });

  afterEach(async () => { await close(); });

  it('认领携带边界声明、预授权与会话引用登记', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));
    expect(claim.status).toBe('active');
    expect(claim.baseline_commit).toBe('b1');
    expect(claim.requirement_keys).toEqual(['dom/a']);
    expect(claim.boundary.fact_types).toEqual([{ type: 'code', scopes: ['src/a/'] }]);
    expect(claim.pre_authorization?.must_stop_conditions).toEqual(['contract change']);
    expect(claim.session_ref).toEqual({ host: 'host-1', workspace: '/repo', native_id: 'sess-1' });

    const active = await listClaims(ctx);
    expect(active.map(item => item.id)).toEqual([claim.id]);
  });

  it('需求键互斥先到先得，事实边界相交不阻止准入', async () => {
    await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));

    await expect(
      createClaim(ctx, claimInput('agent-2', ['dom/a'], boundary(['src/other/']))),
    ).rejects.toBeInstanceOf(ClaimError);
    expect((await listClaims(ctx)).length).toBe(1);

    const overlapping = await createClaim(ctx, claimInput('agent-2', ['dom/b'], boundary(['src/a/'])));
    expect(overlapping.status).toBe('active');
  });

  it('未知需求键与跨域事实类型被拒绝', async () => {
    await expect(
      createClaim(ctx, claimInput('agent-1', ['dom/unknown'], boundary(['src/a/']))),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      createClaim(ctx, {
        ...claimInput('agent-1', ['dom/a'], boundary(['src/a/'])),
        boundary: { fact_types: [{ type: 'host', scopes: ['host-1'] }], read_only: [], escalation: [] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('已投影但未入基线的需求键可认领（引导不阻塞）', async () => {
    await ctx.nodes.insert({
      id: '01J0000000000000000000001',
      type: 'requirement',
      title: '需求D',
      description: '',
      status: 'proposed',
      tags: [],
      created_at: NOW,
      updated_at: NOW,
      metadata: {},
      priority: 'medium',
      source: 'vibespec',
      source_detail: 'dom/d',
      acceptance: null,
    });

    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/d'], boundary(['src/d/'])));
    expect(claim.status).toBe('active');
    expect(claim.requirement_keys).toEqual(['dom/d']);
    expect(claim.baseline_commit).toBe('b1');
  });

  it('非 BOM 投影来源的 requirement 节点不构成准入', async () => {
    await ctx.nodes.insert({
      id: '01J0000000000000000000002',
      type: 'requirement',
      title: '手造需求',
      description: '',
      status: 'proposed',
      tags: [],
      created_at: NOW,
      updated_at: NOW,
      metadata: {},
      priority: 'medium',
      source: 'manual',
      source_detail: 'dom/fake',
      acceptance: null,
    });

    await expect(
      createClaim(ctx, claimInput('agent-1', ['dom/fake'], boundary(['src/fake/']))),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('越界即失败：记录越界证据并关闭认领', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));
    const result = await reportClaim(ctx, claim.id, {
      executor: 'agent-1',
      changed_facts: [{ path: 'src/a/file.ts' }, { path: 'src/b/other.ts' }],
    });
    expect(result.ok).toBe(false);
    expect(result.out_of_scope).toEqual(['src/b/other.ts']);

    const stored = await getClaim(ctx, claim.id);
    expect(stored.status).toBe('failed');

    const evidence = await ctx.gap.getEvidence(`claim:${claim.id}`);
    expect(evidence).not.toBeNull();
    expect((evidence?.payload as { out_of_scope: string[] }).out_of_scope).toEqual(['src/b/other.ts']);
  });

  it('契约子树写入只提案，不判越界', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'], ['vibespec/requirements/'])));
    const result = await reportClaim(ctx, claim.id, {
      executor: 'agent-1',
      changed_facts: [{ path: 'src/a/file.ts' }, { path: 'vibespec/requirements/dom/a.md' }],
    });
    expect(result.ok).toBe(true);
    expect(result.proposal_only).toEqual(['vibespec/requirements/dom/a.md']);
    expect((await getClaim(ctx, claim.id)).status).toBe('active');
  });

  it('边界只能收窄：允许子范围，拒绝放宽', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));
    const narrowed = await narrowClaimBoundary(ctx, claim.id, {
      executor: 'agent-1',
      boundary: boundary(['src/a/sub/']),
    });
    expect(narrowed.boundary.fact_types).toEqual([{ type: 'code', scopes: ['src/a/sub/'] }]);

    await expect(narrowClaimBoundary(ctx, claim.id, {
      executor: 'agent-1',
      boundary: boundary(['src/']),
    })).rejects.toMatchObject({ status: 409 });
  });

  it('收窄不得删除只读范围或升级规则', async () => {
    const declared = boundary(['src/a/']);
    declared.read_only = ['src/a/secret/'];
    declared.escalation = ['契约变更经提案'];
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], declared));

    const dropReadOnly: BoundaryDeclaration = {
      fact_types: [{ type: 'code', scopes: ['src/a/'] }],
      read_only: [],
      escalation: ['契约变更经提案'],
    };
    await expect(narrowClaimBoundary(ctx, claim.id, {
      executor: 'agent-1',
      boundary: dropReadOnly,
    })).rejects.toMatchObject({ status: 409 });

    const dropEscalation: BoundaryDeclaration = {
      fact_types: [{ type: 'code', scopes: ['src/a/'] }],
      read_only: ['src/a/secret/'],
      escalation: [],
    };
    await expect(narrowClaimBoundary(ctx, claim.id, {
      executor: 'agent-1',
      boundary: dropEscalation,
    })).rejects.toMatchObject({ status: 409 });

    const kept: BoundaryDeclaration = {
      fact_types: [{ type: 'code', scopes: ['src/a/sub/'] }],
      read_only: ['src/a/secret/'],
      escalation: ['契约变更经提案'],
    };
    const narrowed = await narrowClaimBoundary(ctx, claim.id, { executor: 'agent-1', boundary: kept });
    expect(narrowed.boundary.fact_types).toEqual([{ type: 'code', scopes: ['src/a/sub/'] }]);
    expect(narrowed.boundary.read_only).toEqual(['src/a/secret/']);
  });

  it('契约提案经基线前移转为 confirmed，认领同时作废', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));
    const refs = [{ path: 'vibespec/requirements/dom/a.md', commit: 'aa1' }];
    const proposal = await proposeClaimContractChange(ctx, claim.id, {
      proposer: 'agent-1',
      summary: '补充判据',
      requirement_keys: ['dom/a'],
      refs,
    });

    const changed = bom();
    changed.commit = 'b3';
    changed.requirements[0] = { ...changed.requirements[0], title: '需求A（再修订）' };
    await setBaseline(ctx, {
      commit: 'b3',
      requirements: changed.requirements,
    });

    expect((await ctx.proposals.getProposal(proposal.id))?.status).toBe('confirmed');
    expect((await getClaim(ctx, claim.id)).status).toBe('expired');
  });

  it('租约过期后需求键回到可领取，失效认领保留痕迹', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));
    await sql`UPDATE claims SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE project_id = 'default'`;

    const again = await createClaim(ctx, claimInput('agent-2', ['dom/a'], boundary(['src/a/'])));
    expect(again.executor).toBe('agent-2');
    expect((await getClaim(ctx, claim.id)).status).toBe('expired');
  });

  it('续租延长有效期，撤销释放需求键并记录原因', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));
    const renewed = await renewClaim(ctx, claim.id, { executor: 'agent-1' });
    expect(renewed.lease_expires_at >= claim.lease_expires_at).toBe(true);

    const released = await releaseClaim(ctx, claim.id, { executor: 'agent-1' });
    expect(released.status).toBe('released');

    const second = await createClaim(ctx, claimInput('agent-2', ['dom/a'], boundary(['src/a/'])));
    const revoked = await revokeClaim(ctx, second.id, { revoked_by: 'human', reason: '需求变更' });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revoked_reason).toContain('需求变更');
    expect((await listClaims(ctx)).length).toBe(0);
  });

  it('基线前移导致责任范围变化时旧认领作废', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], boundary(['src/a/'])));
    const changed = bom();
    changed.commit = 'b2';
    changed.requirements[0] = { ...changed.requirements[0], title: '需求A（修订）' };
    await setBaseline(ctx, {
      commit: 'b2',
      requirements: changed.requirements,
    });

    expect((await getClaim(ctx, claim.id)).status).toBe('expired');
    const again = await createClaim(ctx, claimInput('agent-2', ['dom/a'], boundary(['src/a/'])));
    expect(again.executor).toBe('agent-2');
  });

  it('只读范围不可写，写入即越界', async () => {
    const declared = boundary(['src/a/']);
    declared.read_only = ['src/a/secret/'];
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a'], declared));
    const result = await reportClaim(ctx, claim.id, {
      executor: 'agent-1',
      changed_facts: [{ path: 'src/a/secret/token.ts' }, { path: 'src/a/main.ts' }],
    });
    expect(result.ok).toBe(false);
    expect(result.out_of_scope).toEqual(['src/a/secret/token.ts']);
  });

  it('契约子树写入走提案通道，确认由基线前移产生', async () => {
    const claim = await createClaim(ctx, claimInput('agent-1', ['dom/a', 'dom/b'], boundary(['src/a/'])));
    const refs = [{ path: 'vibespec/requirements/dom/a.md', commit: 'aa1' }];
    const proposal = await proposeClaimContractChange(ctx, claim.id, {
      proposer: 'agent-1',
      summary: '补充判据',
      requirement_keys: ['dom/a'],
      refs,
    });
    expect(proposal.claim_id).toBe(claim.id);
    expect(proposal.status).toBe('proposed');
    expect((await ctx.proposals.getProposal(proposal.id))?.refs).toEqual(refs);

    const legacy = {
      proposer: 'agent-1', summary: '夹带正文', requirement_keys: ['dom/a'], refs,
      detail: { heavy: 'x'.repeat(64) },
    } as unknown as Parameters<typeof proposeClaimContractChange>[2];
    await expect(proposeClaimContractChange(ctx, claim.id, legacy)).rejects.toThrow(/Unrecognized key/);

    await expect(proposeClaimContractChange(ctx, claim.id, {
      proposer: 'agent-1',
      summary: '越范围',
      requirement_keys: ['dom/c'],
      refs,
    })).rejects.toMatchObject({ status: 409 });
  });
});
