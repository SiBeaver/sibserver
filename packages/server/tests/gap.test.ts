import { describe, it, expect, beforeEach } from 'vitest';
import { createTestSql } from './helpers/test-db.js';
import { OperationContext } from '../src/operations/context.js';
import { setBaseline, reportEvidence, reconcile, listGaps, buildEvidenceScene } from '../src/gap/engine.js';
import type { BomSnapshot } from '../src/gap/types.js';

const NOW = '2026-07-28T02:00:00.000Z';
const LATER = '2026-07-28T03:00:00.000Z';

function bomV1(): BomSnapshot {
  return {
    commit: 'aaa1111',
    requirements: [
      {
        key: 'dom/req-a',
        title: '需求A',
        rules: [
          { id: 'r-aaaa', title: '认证生效' },
          { id: 'r-bbbb', title: '日志完整' },
        ],
      },
      {
        key: 'dom/req-b',
        title: '需求B',
        rules: [{ id: 'r-cccc', title: '文档齐备' }],
      },
    ],
    constraints: [
      {
        id: 'c1',
        title: '认证中间件',
        dimension: 'security',
        severity: 'critical',
        description: '',
        condition: { evidence_type: 'code_pattern', scope: 'src/', pattern: 'auth', operator: 'present_in_all' },
        requirement_key: 'dom/req-a',
      },
    ],
  };
}

describe('Gap 引擎三方对账', () => {
  let ctx: OperationContext;
  let close: () => void;

  beforeEach(() => {
    const t = createTestSql();
    ctx = new OperationContext(t.sql, 'default');
    close = t.close;
  });

  it('未设基准时 reconcile 报错，listGaps 返回空账单', async () => {
    await expect(reconcile(ctx)).rejects.toThrow(/No baseline/);
    const ledger = await listGaps(ctx);
    expect(ledger.bom_commit).toBeNull();
    expect(ledger.gaps).toEqual([]);
  });

  it('规则无人认领输出缺失型（固定 medium），约束无证据不误报违约', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    const ledger = await listGaps(ctx);
    expect(ledger.bom_commit).toBe('aaa1111');
    expect(ledger.summary.violation).toBe(0);
    // 三条规则无人认领 + 约束 c1 无证据一条
    expect(ledger.summary.absence).toBe(4);
    const c1 = ledger.gaps.find(g => g.source_ref === 'c1');
    expect(c1?.kind).toBe('absence');
    expect(c1?.detail).toContain('no pattern evidence');
    const rAaaa = ledger.gaps.find(g => g.source_ref === 'r-aaaa');
    expect(rAaaa?.kind).toBe('absence');
    expect(rAaaa?.detail).toContain('@sibom');
    // 需求已无优先级：严重度固定 medium
    expect(rAaaa?.severity).toBe('medium');
  });

  it('证据违约输出 violation，附期望 vs 实际', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }], LATER);
    const ledger = await listGaps(ctx);
    const c1 = ledger.gaps.find(g => g.source_ref === 'c1');
    expect(c1?.kind).toBe('violation');
    expect(c1?.detail).toContain('期望');
    expect(c1?.detail).toContain('2/5');
    // 旧缺失行已被证据变化驱动消失
    expect(ledger.gaps.filter(g => g.source_ref === 'c1')).toHaveLength(1);
  });

  it('差距消失的唯一路径：证据满足条件（规则被认领）', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, [
      { source_id: 'constraint:c1', payload: { matched: 5, total: 5 } },
      { source_id: 'sibom-tags', payload: { rules: [{ id: 'r-aaaa', file: 'src/a.ts' }, { id: 'r-bbbb', file: 'src/a.ts' }] } },
    ], LATER);
    const ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')).toBeUndefined();
    expect(ledger.gaps.find(g => g.source_ref === 'r-aaaa')).toBeUndefined();
    expect(ledger.gaps.find(g => g.source_ref === 'r-bbbb')).toBeUndefined();
    // req-b 的规则仍无人认领
    expect(ledger.gaps.find(g => g.source_ref === 'r-cccc')?.kind).toBe('absence');
    // 留痕：resolved 行仍在全量账本中
    const all = await ctx.gap.getAllRows();
    expect(all.filter(r => r.status === 'resolved').length).toBeGreaterThan(0);
  });

  it('需求过时检测：需求键失配可发现（约束 / sibs 节点 / @bom 标签 / 在办 goal / @sibom 悬空）', async () => {
    const bom = bomV1();
    bom.constraints.push({
      id: 'c-gone',
      title: '孤儿约束',
      dimension: 'quality',
      severity: 'low',
      description: '',
      condition: { evidence_type: 'code_pattern', scope: 'x/', pattern: 'y', operator: 'present' },
      requirement_key: 'dom/gone',
    });
    await ctx.nodes.insert({
      id: 'req-node-1', type: 'requirement', title: '幽灵需求', description: '', status: 'proposed',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      priority: 'medium', source: 'specs-md', source_detail: 'dom/ghost', acceptance: null,
    });
    await ctx.nodes.insert({
      id: 'goal-1', type: 'goal', title: '在办单', description: '', status: 'active',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      horizon: 'short', success_criteria: [], priority: 'high',
    });
    await ctx.edges.insert({
      id: 'e1', source_id: 'goal-1', target_id: 'req-node-1', relation: 'fulfills',
      weight: null, annotation: null, created_at: NOW,
    });
    await setBaseline(ctx, bom, NOW);
    await reportEvidence(ctx, [
      { source_id: 'bom-tags', payload: { tags: [{ key: 'dom/dead', file: 'src/a.ts' }, { key: 'dom/req-a', file: 'src/b.ts' }] } },
      { source_id: 'sibom-tags', payload: { rules: [{ id: 'r-zzzz', file: 'src/x.ts' }] } },
    ], LATER);
    const ledger = await listGaps(ctx);
    const stale = ledger.gaps.filter(g => g.kind === 'staleness');
    expect(stale.map(g => g.requirement_key).sort()).toEqual(['(global)', 'dom/dead', 'dom/ghost', 'dom/ghost', 'dom/gone'].sort());
    expect(stale.find(g => g.source_ref === 'c-gone')).toBeTruthy();
    expect(stale.find(g => g.source_ref === 'goal-1')).toBeTruthy();
    expect(stale.find(g => g.source_ref === '@bom:dom/dead')?.detail).toContain('src/a.ts');
    const staleSibom = stale.find(g => g.source_ref === '@sibom:r-zzzz');
    expect(staleSibom).toBeTruthy();
    expect(staleSibom?.detail).toContain('src/x.ts');
    expect(staleSibom?.severity).toBe('medium');
  });

  it('goal 标注：创建在办 goal 后差距不消失，附在办标记', async () => {
    await ctx.nodes.insert({
      id: 'req-node-a', type: 'requirement', title: '需求A', description: '', status: 'in_execution',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      priority: 'high', source: 'specs-md', source_detail: 'dom/req-a', acceptance: null,
    });
    await ctx.nodes.insert({
      id: 'goal-a', type: 'goal', title: '弥合A', description: '', status: 'active',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      horizon: 'short', success_criteria: [], priority: 'high',
    });
    await ctx.edges.insert({
      id: 'e-a', source_id: 'goal-a', target_id: 'req-node-a', relation: 'fulfills',
      weight: null, annotation: null, created_at: NOW,
    });
    await setBaseline(ctx, bomV1(), NOW);
    const ledger = await listGaps(ctx);
    const reqAGaps = ledger.gaps.filter(g => g.requirement_key === 'dom/req-a');
    expect(reqAGaps.length).toBeGreaterThan(0);
    for (const g of reqAGaps) {
      expect(g.in_progress_goal).toEqual({ id: 'goal-a', title: '弥合A' });
    }
    const reqBGap = ledger.gaps.find(g => g.requirement_key === 'dom/req-b');
    expect(reqBGap?.in_progress_goal).toBeNull();
  });

  it('豁免：指纹不变静默标记，过期或指纹变化重新报', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    let ledger = await listGaps(ctx);
    const c1 = ledger.gaps.find(g => g.source_ref === 'c1')!;
    await ctx.gap.upsertWaiver({
      fingerprint: c1.condition_fingerprint, reason: '第一期冻结', expires_at: null, created_at: NOW,
    });
    ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')?.waiver?.reason).toBe('第一期冻结');
    expect(ledger.summary.waived).toBe(1);

    // 过期豁免失效
    await ctx.gap.upsertWaiver({
      fingerprint: c1.condition_fingerprint, reason: '已过期', expires_at: '2020-01-01T00:00:00.000Z', created_at: NOW,
    });
    ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')?.waiver).toBeNull();

    // 条件变化 → 指纹变化 → 旧豁免不再命中
    await ctx.gap.upsertWaiver({
      fingerprint: c1.condition_fingerprint, reason: '重新豁免', expires_at: null, created_at: NOW,
    });
    const bom2 = bomV1();
    bom2.commit = 'bbb2222';
    (bom2.constraints[0].condition as { pattern: string }).pattern = 'auth-v2';
    await setBaseline(ctx, bom2, LATER);
    ledger = await listGaps(ctx);
    const c1v2 = ledger.gaps.find(g => g.source_ref === 'c1')!;
    expect(c1v2.condition_fingerprint).not.toBe(c1.condition_fingerprint);
    expect(c1v2.waiver).toBeNull();
  });

  it('增量重算：基准前移仅 rebase diff 涉及的需求键，旧行作废留痕', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    const before = await ctx.gap.getOpenRows();
    const reqARowIds = before.filter(r => r.requirement_key === 'dom/req-a').map(r => r.id).sort();

    const bom2 = bomV1();
    bom2.commit = 'bbb2222';
    bom2.requirements[1].rules.push({ id: 'r-cccc2', title: '新增规则' });
    const result = await setBaseline(ctx, bom2, LATER);
    expect(result.changed_keys).toEqual(['dom/req-b']);
    expect(result.superseded).toBe(1);

    const after = await ctx.gap.getOpenRows();
    // req-a 的行未被触碰（同 id 同 detected_at）
    const reqARowsAfter = after.filter(r => r.requirement_key === 'dom/req-a');
    expect(reqARowsAfter.map(r => r.id).sort()).toEqual(reqARowIds);
    expect(reqARowsAfter.every(r => r.detected_at === NOW)).toBe(true);
    expect(reqARowsAfter.every(r => r.bom_commit === 'aaa1111')).toBe(true);
    // req-b 旧行作废留痕，新行锚新基准
    const all = await ctx.gap.getAllRows();
    expect(all.filter(r => r.requirement_key === 'dom/req-b' && r.status === 'superseded')).toHaveLength(1);
    const reqBOpen = after.filter(r => r.requirement_key === 'dom/req-b');
    expect(reqBOpen).toHaveLength(2);
    expect(reqBOpen.every(r => r.bom_commit === 'bbb2222')).toBe(true);
  });

  it('证据指纹不变不重算（skipped），变化才触发', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    const r1 = await reportEvidence(ctx, [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }], LATER);
    expect(r1.accepted).toBe(1);
    const r2 = await reportEvidence(ctx, [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }], LATER);
    expect(r2.accepted).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.inserted + r2.refreshed + r2.resolved).toBe(0);
  });

  it('gap 账本派生性：全量对账幂等，可由基准 + 证据集完全重建', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }], LATER);
    const first = await ctx.gap.getOpenRows();
    const again = await reconcile(ctx, null, LATER);
    expect(again.inserted).toBe(0);
    expect(again.resolved).toBe(0);
    expect(again.refreshed).toBe(0);
    const second = await ctx.gap.getOpenRows();
    expect(second.map(r => r.id).sort()).toEqual(first.map(r => r.id).sort());
  });

  it('账单证据年龄：有证据行带 evidence_reported_at，无证据行为 null', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, [
      { source_id: 'constraint:c1', payload: { matched: 2, total: 5 }, reported_at: LATER },
    ], LATER);
    let ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')?.evidence_reported_at).toBe(LATER);
    // sibom-tags 未上报 → 规则行无证据 → null
    expect(ledger.gaps.find(g => g.source_ref === 'r-aaaa')?.evidence_reported_at).toBeNull();

    // 上报 sibom-tags 后未认领规则行带证据年龄（认领证据的时点）；已认领的 r-aaaa 消解
    await reportEvidence(ctx, [
      { source_id: 'sibom-tags', payload: { rules: [{ id: 'r-aaaa', file: 'src/a.ts' }] }, reported_at: LATER },
    ], LATER);
    ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'r-aaaa')).toBeUndefined();
    expect(ledger.gaps.find(g => g.source_ref === 'r-cccc')?.evidence_reported_at).toBe(LATER);
  });

  it('对照视图证据聚合：files / runs / sibs_nodes 按需求键过滤', async () => {
    await ctx.nodes.insert({
      id: 'req-node-a', type: 'requirement', title: '需求A', description: '', status: 'in_execution',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      priority: 'high', source: 'specs-md', source_detail: 'dom/req-a', acceptance: null,
    });
    await ctx.nodes.insert({
      id: 'dec-1', type: 'decision', title: '技术选型', description: '', status: 'accepted',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      context: '', rationale: '', alternatives_considered: [], consequences: [],
    });
    await ctx.edges.insert({
      id: 'e-d1', source_id: 'dec-1', target_id: 'req-node-a', relation: 'addresses',
      weight: null, annotation: null, created_at: NOW,
    });
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, [
      { source_id: 'constraint:c1', payload: { matched: 5, total: 5 }, reported_at: LATER },
      { source_id: 'bom-tags', payload: { tags: [
        { key: 'dom/req-a', file: 'src/a.ts' },
        { key: 'dom/req-a', file: 'src/a2.ts' },
        { key: 'dom/req-b', file: 'src/b.ts' },
      ] } },
    ], LATER);

    const scene = await buildEvidenceScene(ctx, 'dom/req-a');
    expect(scene.requirement_key).toBe('dom/req-a');
    expect(scene.files.map(f => f.path).sort()).toEqual(['src/a.ts', 'src/a2.ts']);
    expect(scene.files[0].bom_tag).toBe('@bom dom/req-a');
    // runs：仅约束 c1（pass），验收项证据已退役
    expect(scene.runs).toHaveLength(1);
    expect(scene.runs[0].result).toBe('pass');
    expect(scene.runs[0].reported_at).toBe(LATER);
    // sibs_nodes：需求节点 + 相邻 decision
    expect(scene.sibs_nodes.map(n => n.id).sort()).toEqual(['dec-1', 'req-node-a']);

    // 无任何证据的键 → 空结构不报错
    const empty = await buildEvidenceScene(ctx, 'dom/nothing');
    expect(empty.files).toEqual([]);
    expect(empty.runs).toEqual([]);
    expect(empty.sibs_nodes).toEqual([]);
  });
});
