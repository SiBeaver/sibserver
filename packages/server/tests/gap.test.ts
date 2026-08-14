import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../core/tests/helpers/test-db.js';
import { SCHEMA_SQL } from '../../core/src/storage/db.js';
import { OperationContext } from '@sibeaver/core';
import { setBaseline, reportEvidence, reconcile, listGaps, buildEvidenceScene, fingerprint, signWaiversByCondition } from '../src/gap/engine.js';
import { createSiBeaverApp } from '../src/api/server.js';
import { registerTools } from '../src/mcp/tools.js';
import type { BomSnapshot } from '@sibeaver/core';

const NOW = '2026-07-28T02:00:00.000Z';
const LATER = '2026-07-28T03:00:00.000Z';

function schemaSqlSansVector(): string {
  return SCHEMA_SQL.split('\n').filter(l => !/^\s*CREATE EXTENSION/i.test(l)).join('\n');
}

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
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    ctx = new OperationContext(t.sql, 'default');
    close = t.close;
  });

  afterEach(async () => { await close(); });

  it('未设基准时 reconcile 报错，listGaps 返回空账单', async () => {
    await expect(reconcile(ctx)).rejects.toThrow(/未设基准/);
    const ledger = await listGaps(ctx);
    expect(ledger.bom_commit).toBeNull();
    expect(ledger.gaps).toEqual([]);
  });

  it('首次上报基准缺分区默认空分区，另一分区随同 commit 合并补齐', async () => {
    const r0 = await setBaseline(ctx, { commit: 'c1', requirements: [] }, NOW);
    expect(r0.changed_keys).toEqual([]);
    const baseline0 = await ctx.gap.getBaseline();
    expect(baseline0?.bom.constraints).toEqual([]);
    // 后续同 commit 分区合并补齐 constraints
    const r1 = await setBaseline(ctx, { commit: 'c1', constraints: bomV1().constraints }, NOW);
    expect(r1.changed_keys).toEqual(['dom/req-a']);
    const baseline1 = await ctx.gap.getBaseline();
    expect(baseline1?.bom.constraints).toHaveLength(1);
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
    expect(c1?.evidence_source).toBe('constraint:c1');
    const rAaaa = ledger.gaps.find(g => g.source_ref === 'r-aaaa');
    expect(rAaaa?.kind).toBe('absence');
    expect(rAaaa?.detail).toContain('@sibom');
    expect(rAaaa?.evidence_source).toBe('sibom-tags:r-aaaa');
    // 需求已无优先级：严重度固定 medium
    expect(rAaaa?.severity).toBe('medium');
  });

  it('证据违约输出 violation，附期望 vs 实际', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, { items: [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }] }, LATER);
    const ledger = await listGaps(ctx);
    const c1 = ledger.gaps.find(g => g.source_ref === 'c1');
    expect(c1?.kind).toBe('violation');
    expect(c1?.evidence_source).toBe('constraint:c1');
    expect(c1?.detail).toContain('期望');
    expect(c1?.detail).toContain('2/5');
    // 旧缺失行已被证据变化驱动消失
    expect(ledger.gaps.filter(g => g.source_ref === 'c1')).toHaveLength(1);
  });

  it('差距消失的唯一路径：证据满足条件（规则被认领）', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, {
      items: [
        { source_id: 'constraint:c1', payload: { matched: 5, total: 5 } },
        { source_id: 'sibom-tags', payload: { rules: [{ id: 'r-aaaa', file: 'src/a.ts' }, { id: 'r-bbbb', file: 'src/a.ts' }] } },
      ],
    }, LATER);
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

  it('需求过时检测：需求键失配可发现（约束 / sibs 节点 / @bom 标签 / 在办 witem / @sibom 悬空）', async () => {
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
      id: 'witem-1', type: 'witem', title: '在办单', description: '', status: 'active',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      horizon: 'short', success_criteria: [], priority: 'high',
    });
    await ctx.edges.insert({
      id: 'e1', source_id: 'witem-1', target_id: 'req-node-1', relation: 'fulfills',
      weight: null, annotation: null, created_at: NOW,
    });
    await setBaseline(ctx, bom, NOW);
    await reportEvidence(ctx, {
      items: [
        { source_id: 'bom-tags', payload: { tags: [{ key: 'dom/dead', file: 'src/a.ts' }, { key: 'dom/req-a', file: 'src/b.ts' }] } },
        { source_id: 'sibom-tags', payload: { rules: [{ id: 'r-zzzz', file: 'src/x.ts' }] } },
      ],
    }, LATER);
    const ledger = await listGaps(ctx);
    const stale = ledger.gaps.filter(g => g.kind === 'staleness');
    expect(stale.map(g => g.requirement_key).sort()).toEqual(['(global)', 'dom/dead', 'dom/ghost', 'dom/ghost', 'dom/gone'].sort());
    expect(stale.find(g => g.source_ref === 'c-gone')?.evidence_source).toBe('constraint:c-gone');
    expect(stale.find(g => g.source_ref === 'witem-1')?.evidence_source).toBe('witem:witem-1');
    expect(stale.find(g => g.source_ref === '@bom:dom/dead')?.detail).toContain('src/a.ts');
    const staleSibom = stale.find(g => g.source_ref === '@sibom:r-zzzz');
    expect(staleSibom).toBeTruthy();
    expect(staleSibom?.detail).toContain('src/x.ts');
    expect(staleSibom?.severity).toBe('medium');
  });

  it('已废弃 requirement 节点不报需求过时，活跃节点仍报', async () => {
    await ctx.nodes.insert({
      id: 'req-deprecated', type: 'requirement', title: '旧域需求', description: '', status: 'deprecated',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      priority: 'medium', source: 'vibespec', source_detail: 'old-domain/ghost', acceptance: null,
    });
    await ctx.nodes.insert({
      id: 'req-active', type: 'requirement', title: '失键需求', description: '', status: 'in_execution',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      priority: 'medium', source: 'vibespec', source_detail: 'dom/ghost', acceptance: null,
    });
    await setBaseline(ctx, bomV1(), NOW);
    const ledger = await listGaps(ctx);
    const stale = ledger.gaps.filter(g => g.kind === 'staleness' && g.source_ref === 'req-deprecated' || g.source_ref === 'req-active');
    expect(stale.find(g => g.source_ref === 'req-deprecated')).toBeUndefined();
    expect(stale.find(g => g.source_ref === 'req-active')).toBeTruthy();
  });

  it('witem 标注：创建在办 witem 后差距不消失，附在办标记', async () => {
    await ctx.nodes.insert({
      id: 'req-node-a', type: 'requirement', title: '需求A', description: '', status: 'in_execution',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      priority: 'high', source: 'specs-md', source_detail: 'dom/req-a', acceptance: null,
    });
    await ctx.nodes.insert({
      id: 'witem-a', type: 'witem', title: '弥合A', description: '', status: 'active',
      tags: [], created_at: NOW, updated_at: NOW, metadata: {},
      horizon: 'short', success_criteria: [], priority: 'high',
    });
    await ctx.edges.insert({
      id: 'e-a', source_id: 'witem-a', target_id: 'req-node-a', relation: 'fulfills',
      weight: null, annotation: null, created_at: NOW,
    });
    await setBaseline(ctx, bomV1(), NOW);
    const ledger = await listGaps(ctx);
    const reqAGaps = ledger.gaps.filter(g => g.requirement_key === 'dom/req-a');
    expect(reqAGaps.length).toBeGreaterThan(0);
    for (const g of reqAGaps) {
      expect(g.in_progress_witem).toEqual({ id: 'witem-a', title: '弥合A' });
    }
    const reqBGap = ledger.gaps.find(g => g.requirement_key === 'dom/req-b');
    expect(reqBGap?.in_progress_witem).toBeNull();
  });

  it('豁免：指纹不变静默标记，过期或指纹变化重新报', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    let ledger = await listGaps(ctx);
    const c1 = ledger.gaps.find(g => g.source_ref === 'c1')!;
    await ctx.gap.upsertWaiver({
      fingerprint: fingerprint({ condition_fingerprint: c1.condition_fingerprint, evidence_source: c1.evidence_source }),
      reason: '第一期冻结', expires_at: null, created_at: NOW,
    });
    ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')?.waiver?.reason).toBe('第一期冻结');
    expect(ledger.summary.waived).toBe(1);

    // 过期豁免失效
    await ctx.gap.upsertWaiver({
      fingerprint: fingerprint({ condition_fingerprint: c1.condition_fingerprint, evidence_source: c1.evidence_source }),
      reason: '已过期', expires_at: '2020-01-01T00:00:00.000Z', created_at: NOW,
    });
    ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')?.waiver).toBeNull();

    // 条件变化 → 指纹变化 → 旧豁免不再命中
    await ctx.gap.upsertWaiver({
      fingerprint: fingerprint({ condition_fingerprint: c1.condition_fingerprint, evidence_source: c1.evidence_source }),
      reason: '重新豁免', expires_at: null, created_at: NOW,
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
    const r1 = await reportEvidence(ctx, { items: [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }] }, LATER);
    expect(r1.accepted).toBe(1);
    const r2 = await reportEvidence(ctx, { items: [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }] }, LATER);
    expect(r2.accepted).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.inserted + r2.refreshed + r2.resolved).toBe(0);
  });

  it('gap 账本派生性：全量对账幂等，可由基准 + 证据集完全重建', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, { items: [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }] }, LATER);
    const first = await ctx.gap.getOpenRows();
    const again = await reconcile(ctx, { ruleKeys: null, constraintKeys: null }, LATER);
    expect(again.inserted).toBe(0);
    expect(again.resolved).toBe(0);
    expect(again.refreshed).toBe(0);
    const second = await ctx.gap.getOpenRows();
    expect(second.map(r => r.id).sort()).toEqual(first.map(r => r.id).sort());
  });

  it('账单证据年龄：有证据行带 evidence_reported_at，无证据行为 null', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, {
      items: [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 }, reported_at: LATER }],
    }, LATER);
    let ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')?.evidence_reported_at).toBe(LATER);
    // sibom-tags 未上报 → 规则行无证据 → null
    expect(ledger.gaps.find(g => g.source_ref === 'r-aaaa')?.evidence_reported_at).toBeNull();

    // 上报 sibom-tags 后未认领规则行带证据年龄（认领证据的时点）
    await reportEvidence(ctx, {
      items: [{ source_id: 'sibom-tags', payload: { rules: [{ id: 'r-aaaa', file: 'src/a.ts' }] }, reported_at: LATER }],
    }, LATER);
    ledger = await listGaps(ctx);
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
    await reportEvidence(ctx, {
      items: [
        { source_id: 'constraint:c1', payload: { matched: 5, total: 5 }, reported_at: LATER },
        { source_id: 'bom-tags', payload: { tags: [
          { key: 'dom/req-a', file: 'src/a.ts' },
          { key: 'dom/req-a', file: 'src/a2.ts' },
          { key: 'dom/req-b', file: 'src/b.ts' },
        ] } },
      ],
    }, LATER);

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

  // ── r-gl3c：身份三元组 ────────────────────────────────────

  it('r-gl3c：同一差距重复 reconcile 落回同一行，不重复开账', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, { items: [{ source_id: 'constraint:c1', payload: { matched:2, total: 5 } }] }, LATER);
    const first = await ctx.gap.getOpenRows();
    const again = await reconcile(ctx, { ruleKeys: null, constraintKeys: null }, LATER);
    expect(again.inserted).toBe(0);
    const second = await ctx.gap.getOpenRows();
    expect(second).toHaveLength(first.length);
    expect(second.map(r => r.id).sort()).toEqual(first.map(r => r.id).sort());
  });

  it('r-gl3c：不同证据源同 kind 同 key 各自成行', async () => {
    const bom = bomV1();
    bom.constraints.push({
      id: 'c2',
      title: '第二约束',
      dimension: 'quality',
      severity: 'medium',
      description: '',
      condition: { evidence_type: 'code_pattern', scope: 'y/', pattern: 'z', operator: 'present' },
      requirement_key: 'dom/req-a',
    });
    await setBaseline(ctx, bom, NOW);
    const rows = await ctx.gap.getOpenRows();
    const c1 = rows.find(r => r.source_ref === 'c1');
    const c2 = rows.find(r => r.source_ref === 'c2');
    expect(c1?.kind).toBe('absence');
    expect(c2?.kind).toBe('absence');
    expect(c1?.evidence_source).toBe('constraint:c1');
    expect(c2?.evidence_source).toBe('constraint:c2');
    expect(c1?.id).not.toBe(c2?.id);
  });

  // ── r-gd7g：豁免与差距绑定 ────────────────────────────────

  it('r-gd7g：证据源变化 → 豁免指纹变 → 该行重新提醒', async () => {
    const bom = bomV1();
    bom.constraints.push({
      id: 'c2',
      title: '第二约束',
      dimension: 'quality',
      severity: 'medium',
      description: '',
      condition: { evidence_type: 'code_pattern', scope: 'y/', pattern: 'z', operator: 'present' },
      requirement_key: 'dom/req-a',
    });
    await setBaseline(ctx, bom, NOW);
    let ledger = await listGaps(ctx);
    const c1 = ledger.gaps.find(g => g.source_ref === 'c1')!;
    const c2 = ledger.gaps.find(g => g.source_ref === 'c2')!;
    // 对两行（同 key 同 kind 不同证据源）签豁免：按 condition_fingerprint 反查只命中各自的 evidence_source 键
    await signWaiversByCondition(ctx, c1.condition_fingerprint, '冻结 c1', null);
    await signWaiversByCondition(ctx, c2.condition_fingerprint, '冻结 c2', null);
    ledger = await listGaps(ctx);
    expect(ledger.gaps.find(g => g.source_ref === 'c1')?.waiver?.reason).toBe('冻结 c1');
    expect(ledger.gaps.find(g => g.source_ref === 'c2')?.waiver?.reason).toBe('冻结 c2');

    // c1 证据源不变但 condition 变化（约束判定变化）→ 指纹变 → 豁免失效
    const bom2 = bom;
    bom2.commit = 'bbb2222';
    (bom2.constraints[0].condition as { pattern: string }).pattern = 'auth-v3';
    await setBaseline(ctx, bom2, LATER);
    ledger = await listGaps(ctx);
    const c1v2 = ledger.gaps.find(g => g.source_ref === 'c1')!;
    expect(c1v2.condition_fingerprint).not.toBe(c1.condition_fingerprint);
    expect(c1v2.waiver).toBeNull();
    // c2 未被触及 → 豁免仍在
    expect(ledger.gaps.find(g => g.source_ref === 'c2')?.waiver?.reason).toBe('冻结 c2');
  });

  it('r-gd7g：直接构造不同 evidence_source 的差距行 → 旧豁免不命中', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    const ledger = await listGaps(ctx);
    const c1 = ledger.gaps.find(g => g.source_ref === 'c1')!;
    await signWaiversByCondition(ctx, c1.condition_fingerprint, '冻结', null);
    // 同 condition_fingerprint 但不同 evidence_source 的行（构造）→ 豁免键不同 → waiver null
    await ctx.gap.insertRow({
      id: 'manual-row-1', requirement_key: 'dom/req-a', kind: 'absence',
      title: '构造行', detail: 'x', severity: 'medium', source_ref: 'c1',
      evidence_source: 'constraint:c-other',
      bom_commit: 'aaa1111', condition_fingerprint: c1.condition_fingerprint,
      evidence_fingerprint: null, status: 'open', detected_at: NOW,
      resolved_at: null, superseded_at: null,
    });
    const ledger2 = await listGaps(ctx);
    expect(ledger2.gaps.find(g => g.source_ref === 'c1')?.waiver?.reason).toBe('冻结');
    expect(ledger2.gaps.find(g => g.id === 'manual-row-1')?.waiver).toBeNull();
  });

  // ── r-gl5e：增量演化 ──────────────────────────────────────

  it('r-gl5e：只报 constraint:c1 证据 → 其他键差距行 unaffected，无全量刷新副作用', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    const before = await ctx.gap.getOpenRows();
    const reqBIds = before.filter(r => r.requirement_key === 'dom/req-b').map(r => r.id).sort();
    const r = await reportEvidence(ctx, { items: [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 } }] }, LATER);
    // 只重算 constraint:c1 命中键：c1 缺失→违约（resolved 1 + inserted 1）；规则认领行不在范围（unchanged 0）
    expect(r.resolved).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.refreshed).toBe(0);
    expect(r.unchanged).toBe(0);
    // dom/req-b 行完全未动
    const after = await ctx.gap.getOpenRows();
    const reqBAfter = after.filter(r => r.requirement_key === 'dom/req-b');
    expect(reqBAfter.map(r => r.id).sort()).toEqual(reqBIds);
    expect(reqBAfter.every(r => r.detected_at === NOW)).toBe(true);
  });

  it('r-gl5e：仅 sibom-tags 证据变化 → 重算全部规则认领，约束行不动', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    const before = await ctx.gap.getOpenRows();
    const c1Row = before.find(r => r.source_ref === 'c1')!;
    const r = await reportEvidence(ctx, {
      items: [{ source_id: 'sibom-tags', payload: { rules: [{ id: 'r-aaaa', file: 'src/a.ts' }] } }],
    }, LATER);
    // r-aaaa 认领后缺失行 resolved；r-bbbb/r-cccc 仍在；c1 不在重算范围，行完全未动
    expect(r.resolved).toBe(1);
    expect(r.inserted).toBe(0);
    const after = await ctx.gap.getOpenRows();
    expect(after.find(x => x.source_ref === 'r-aaaa')).toBeUndefined();
    expect(after.find(x => x.source_ref === 'r-bbbb')?.kind).toBe('absence');
    const c1After = after.find(x => x.source_ref === 'c1')!;
    expect(c1After.id).toBe(c1Row.id);
    expect(c1After.detected_at).toBe(NOW);
  });

  // ── r-el3c：证据按契约版本组织 ────────────────────────────

  it('r-el3c：上报证据带 baseline_commit → 历史留痕可见两条（含旧版）', async () => {
    await setBaseline(ctx, bomV1(), NOW);
    await reportEvidence(ctx, {
      items: [{ source_id: 'constraint:c1', payload: { matched: 2, total: 5 }, baseline_commit: 'aaa1111' }],
    }, LATER);
    const bom2 = bomV1();
    bom2.commit = 'bbb2222';
    await setBaseline(ctx, bom2, LATER);
    await reportEvidence(ctx, {
      items: [{ source_id: 'constraint:c1', payload: { matched: 1, total: 5 }, baseline_commit: 'bbb2222' }],
    }, LATER);
    const history = await ctx.gap.getEvidenceHistory('constraint:c1');
    expect(history).toHaveLength(2);
    // 倒序：最新在前
    expect(history[0].baseline_commit).toBe('bbb2222');
    expect(history[1].baseline_commit).toBe('aaa1111');
    expect(history[1].payload).toEqual({ matched: 2, total: 5 });
  });

  // ── r-vb4d：sibserver 持有基线指针，分区合并 ──────────────

  it('r-vb4d：同 commit 分区合并幂等（二次无新插入）；commit 前移 → 涉键 superseded 留痕', async () => {
    const r0 = await setBaseline(ctx, bomV1(), NOW);
    expect(r0.superseded).toBe(0);

    // 同 commit 分区合并（只报 constraints 分区）→ 无变化
    const r1 = await setBaseline(ctx, { commit: 'aaa1111', constraints: bomV1().constraints }, LATER);
    expect(r1.changed_keys).toEqual([]);
    expect(r1.superseded).toBe(0);
    expect(r1.inserted).toBe(0);
    const countAfterFirst = (await ctx.gap.getAllRows()).length;

    // 二次同请求 → 幂等，无新插入
    const r2 = await setBaseline(ctx, { commit: 'aaa1111', constraints: bomV1().constraints }, LATER);
    expect(r2.inserted).toBe(0);
    expect(r2.superseded).toBe(0);
    expect((await ctx.gap.getAllRows()).length).toBe(countAfterFirst);

    // commit 前移（只报 constraints 分区，requirements 沿用旧值）→ 涉键 superseded 留痕
    const newConstraints = [{
      ...bomV1().constraints[0],
      condition: { evidence_type: 'code_pattern' as const, scope: 'src/', pattern: 'auth-v9', operator: 'present_in_all' as const },
    }];
    const r3 = await setBaseline(ctx, { commit: 'ccc3333', constraints: newConstraints }, LATER);
    expect(r3.changed_keys).toEqual(['dom/req-a']);
    expect(r3.superseded).toBeGreaterThan(0);
    const all = await ctx.gap.getAllRows();
    expect(all.filter(r => r.status === 'superseded').length).toBeGreaterThan(0);
    // 基线指针已前移
    const baseline = await ctx.gap.getBaseline();
    expect(baseline?.bom_commit).toBe('ccc3333');
    expect(baseline?.bom.constraints[0].condition).toEqual(newConstraints[0].condition);
  });

  // ── 迁移幂等 ──────────────────────────────────────────────

  it('迁移幂等：SCHEMA_SQL 连跑两次不报错', async () => {
    const t = await createTestDb();
    try {
      // 不抛错即幂等（createTestDb 已跑过一次，这里再显式跑两次）
      await t.sql.unsafe(schemaSqlSansVector());
      await t.sql.unsafe(schemaSqlSansVector());
    } finally {
      await t.close();
    }
  });
});

describe('r-gd6f 退役：判定只有一处', () => {
  it('POST /constraints/evaluate 404，GET /requirements/:id/gap 404', async () => {
    const { app } = createSiBeaverApp();
    const res1 = await app.request('/default/api/v1/constraints/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constraints: [], evidence: {} }),
    });
    expect(res1.status).toBe(404);
    const res2 = await app.request('/default/api/v1/requirements/any-id/gap', { method: 'GET' });
    expect(res2.status).toBe(404);
  });

  it('MCP：evaluate_constraint 已移除，evaluate_gap 无 requirement_id 参数、无 acceptance_gaps', async () => {
    const t = await createTestDb();
    try {
      const ctx = new OperationContext(t.sql, 'default');
      const registrations: Record<string, (args: any) => Promise<unknown>> = {};
      const fakeServer: any = {
        tool: (...args: unknown[]) => {
          registrations[String(args[0])] = args[args.length - 1] as (a: any) => Promise<unknown>;
        },
      };
      registerTools(fakeServer, { mode: 'scoped', getContext: () => ctx, slug: 'smoke', getMetadata: () => ({}) });
      expect(registrations).not.toHaveProperty('evaluate_constraint');
      expect(registrations).toHaveProperty('evaluate_gap');
      const res = await registrations['evaluate_gap']({ requirement_id: 'x' }) as { content: Array<{ text: string }> };
      const data = JSON.parse(res.content[0].text);
      expect(data).toHaveProperty('bomCommit');
      expect(data).toHaveProperty('gaps');
      expect(data).toHaveProperty('summary');
      expect(data).not.toHaveProperty('acceptanceGaps');
    } finally {
      await t.close();
    }
  });
});
