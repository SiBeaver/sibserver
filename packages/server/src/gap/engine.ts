import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import type { OperationContext } from '@sibeaver/core';
import type { RequirementNode, WitemNode } from '@sibeaver/core';
import type { EvidenceInput, PatternResult } from '@sibeaver/core';
import { evaluateConstraint } from '../policies/constraint-evaluator.js';
import type {
  BomBaselineInput,
  BomSnapshot,
  BomConstraint,
  BomRequirement,
  ConstraintSetInput,
  ConstraintSetRecord,
  ConstraintSetView,
  EvidenceReportInput,
  EvidenceScene,
  GapRowRecord,
  GapView,
  WaiverRecord,
} from '@sibeaver/core';

// ============================================================
// Gap 引擎 — 三方对账：BOM@commit（应然）/ 证据（实然）/ 在办 witem（标注）
//
// 差距只能由对照计算自动发现，不可手动创建/关闭；
// 差距消失的唯一路径是下轮对账时证据满足条件（豁免仅静默）。
// ============================================================

const GLOBAL_KEY = '(global)';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
}

/** 键序无关的稳定序列化——jsonb 往返会重排对象键序，跨 DB 比较相等须按值不按文本 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface DesiredGap {
  requirement_key: string;
  kind: GapRowRecord['kind'];
  title: string;
  detail: string;
  severity: string;
  source_ref: string;
  /** 身份三元组之证据源（r-gl3c）：constraint:{id} / sibom-tags:{ruleId} / @sibom:{ruleId} / node:{id} / witem:{id} */
  evidence_source: string;
  condition_fingerprint: string;
  evidence_fingerprint: string | null;
  /** 约束判定行携带所用约束集；其余行为 null */
  constraint_set_id: string | null;
  constraint_set_hash: string | null;
}

/** 已解析的约束集——对账输入的一部分，独立于基线（r-vb4d） */
export interface ConstraintInput {
  set_id: string | null;
  set_hash: string | null;
  constraints: BomConstraint[];
}

const EMPTY_CONSTRAINTS: ConstraintInput = { set_id: null, set_hash: null, constraints: [] };

function identityOf(g: Pick<DesiredGap, 'requirement_key' | 'kind' | 'evidence_source'>): string {
  return `${g.requirement_key}\u0000${g.kind}\u0000${g.evidence_source}`;
}

function constraintKey(c: BomConstraint): string {
  return c.requirement_key ?? GLOBAL_KEY;
}

// ── 三源计算（纯函数部分 + sibs_query/witem 读图谱）─────────────

/** 重算范围（r-gl5e 增量演化）：ruleKeys 控 Step 1 规则认领、constraintKeys 控 Step 2 约束评估；staleness 恒全量（廉价）。null=全量，空 Set=不重算该类。 */
export interface ReconcileScope {
  ruleKeys: Set<string> | null;
  constraintKeys: Set<string> | null;
  /** 基线前移已删除的需求键：只修剪需求节点 staleness，不隐藏约束/工作项信号 */
  excludeKeys?: Set<string>;
}

const FULL_SCOPE: ReconcileScope = { ruleKeys: null, constraintKeys: null };

// @sibom r-gd1a — 差距是期望（BOM@基线 + 约束集）与现实（证据集）的事实不一致
// @sibom r-gd3c — 差距三型：violation / absence / staleness 均由对照计算产出
async function computeDesiredGaps(
  ctx: OperationContext,
  bom: BomSnapshot,
  constraints: ConstraintInput,
  scope: ReconcileScope,
): Promise<DesiredGap[]> {
  const gaps: DesiredGap[] = [];
  // draft 需求保留身份投影（r-vb5e）：键参与 staleness 身份对照，但规则不参与对账
  const bomKeys = new Set([
    ...bom.requirements.map(r => r.key),
    ...bom.draft_requirements.map(r => r.key),
  ]);
  // 契约要求键（非 draft）：约束判定只在基线契约内进行（r-vb5e）
  const activeKeys = new Set(bom.requirements.map(r => r.key));
  const ruleInScope = (key: string) => scope.ruleKeys === null || scope.ruleKeys.has(key);
  const constraintInScope = (key: string) => scope.constraintKeys === null || scope.constraintKeys.has(key);

  // Step 1: 规则认领对账 → 缺失（BOM 业务规则无人 @sibom 认领）
  const sibomEv = await ctx.gap.getEvidence('sibom-tags');
  const claimedRules = new Set(
    (sibomEv?.payload as { rules?: Array<{ id: string }> } | undefined)?.rules?.map(r => r.id) ?? [],
  );
  for (const req of bom.requirements) {
    if (!ruleInScope(req.key)) continue;
    for (const rule of req.rules ?? []) {
      if (claimedRules.has(rule.id)) continue;
      gaps.push({
        requirement_key: req.key,
        kind: 'absence',
        title: `规则「${rule.title}」无人认领`,
        detail: 'BOM 业务规则没有 @sibom 认领（代码未自报归属）',
        severity: 'medium',
        source_ref: rule.id,
        evidence_source: `sibom-tags:${rule.id}`,
        condition_fingerprint: fingerprint({ t: 'rule', key: req.key, rule: rule.id, title: rule.title, digest: rule.digest ?? null }),
        evidence_fingerprint: sibomEv?.fingerprint ?? null,
        constraint_set_id: null,
        constraint_set_hash: null,
      });
    }
  }

  // Step 2: 约束 vs 证据 → 违约 / 缺失（约束来自独立版本化约束集，不进入基线 r-vb4d）
  for (const constraint of constraints.constraints) {
    const key = constraintKey(constraint);
    if (!constraintInScope(key)) continue;
    if (key !== GLOBAL_KEY && !activeKeys.has(key)) continue; // 键失配/ draft → 不参与约束判定
    const ev = await ctx.gap.getEvidence(`constraint:${constraint.id}`);
    const evidence = buildEvidenceInput(constraint, ev?.payload);
    const result = await evaluateConstraint(constraint, evidence, ctx);
    if (result.satisfied === true) continue;
    // 判定依据含约束集哈希（spec · GapRow.conditionFingerprint）：换约束集即重新提醒
    const conditionFp = fingerprint({ t: 'constraint', id: constraint.id, condition: constraint.condition, set: constraints.set_hash });
    if (result.satisfied === null) {
      gaps.push({
        requirement_key: key,
        kind: 'absence',
        title: `约束「${constraint.title}」无证据数据`,
        detail: result.message,
        severity: constraint.severity,
        source_ref: constraint.id,
        evidence_source: `constraint:${constraint.id}`,
        condition_fingerprint: conditionFp,
        evidence_fingerprint: ev?.fingerprint ?? null,
        constraint_set_id: constraints.set_id,
        constraint_set_hash: constraints.set_hash,
      });
    } else {
      gaps.push({
        requirement_key: key,
        kind: 'violation',
        title: `约束「${constraint.title}」不满足`,
        detail: `期望: ${result.expected}, 实际: ${result.message}`,
        severity: constraint.severity,
        source_ref: constraint.id,
        evidence_source: `constraint:${constraint.id}`,
        condition_fingerprint: conditionFp,
        evidence_fingerprint: ev?.fingerprint ?? fingerprint(result.actual_value),
        constraint_set_id: constraints.set_id,
        constraint_set_hash: constraints.set_hash,
      });
    }
  }

  // Step 3: 需求过时检测 → staleness（结构性对照，始终全量：廉价）
  for (const constraint of constraints.constraints) {
    const key = constraint.requirement_key;
    if (key && !bomKeys.has(key)) {
      gaps.push({
        requirement_key: key,
        kind: 'staleness',
        title: `约束「${constraint.title}」引用的需求键不存在`,
        detail: `constraint ${constraint.id} → ${key} 不在 BOM 中`,
        severity: constraint.severity,
        source_ref: constraint.id,
        evidence_source: `constraint:${constraint.id}`,
        condition_fingerprint: fingerprint({ t: 'stale-constraint', id: constraint.id, key, set: constraints.set_hash }),
        evidence_fingerprint: null,
        constraint_set_id: constraints.set_id,
        constraint_set_hash: constraints.set_hash,
      });
    }
  }

  const requirementNodes = await ctx.nodes.getByType('requirement') as RequirementNode[];
  for (const node of requirementNodes) {
    if (node.status === 'deprecated') continue; // 已废弃节点不再报需求过时（sync 清理路径）
    const key = node.source_detail;
    if (!key || bomKeys.has(key)) continue;
    gaps.push({
      requirement_key: key,
      kind: 'staleness',
      title: `sibs 需求节点「${node.title}」的需求键不在 BOM 中`,
      detail: `node ${node.id} → ${key}`,
      severity: 'medium',
      source_ref: node.id,
      evidence_source: `node:${node.id}`,
      condition_fingerprint: fingerprint({ t: 'stale-node', id: node.id, key }),
      evidence_fingerprint: null,
      constraint_set_id: null,
      constraint_set_hash: null,
    });
  }

  if (sibomEv) {
    const rules = ((sibomEv.payload as { rules?: Array<{ id: string; file: string }> }).rules ?? []);
    // draft 需求的规则保留身份（r-vb5e）：代码认领 draft 规则不算悬空
    const knownRules = new Set([
      ...bom.requirements.flatMap(r => (r.rules ?? []).map(x => x.id)),
      ...bom.draft_requirements.flatMap(r => (r.rules ?? []).map(x => x.id)),
    ]);
    const staleByRule = new Map<string, string[]>();
    for (const rule of rules) {
      if (knownRules.has(rule.id)) continue;
      const files = staleByRule.get(rule.id) ?? [];
      files.push(rule.file);
      staleByRule.set(rule.id, files);
    }
    for (const [ruleId, files] of staleByRule) {
      gaps.push({
        requirement_key: GLOBAL_KEY,
        kind: 'staleness',
        title: `代码 @sibom 认领指向不存在的规则`,
        detail: `${ruleId} — ${files.join(', ')}`,
        severity: 'medium',
        source_ref: `@sibom:${ruleId}`,
        evidence_source: `@sibom:${ruleId}`,
        condition_fingerprint: fingerprint({ t: 'stale-sibom', rule: ruleId }),
        evidence_fingerprint: fingerprint(files),
        constraint_set_id: null,
        constraint_set_hash: null,
      });
    }
  }

  const witems = await ctx.nodes.getByTypeAndStatus('witem', 'active') as WitemNode[];
  for (const witem of witems) {
    const edges = await ctx.edges.getBySource(witem.id);
    for (const edge of edges.filter(e => e.relation === 'fulfills')) {
      const target = await ctx.nodes.getById(edge.target_id);
      if (!target || target.type !== 'requirement') continue;
      const key = (target as RequirementNode).source_detail;
      if (!key || bomKeys.has(key)) continue;
      gaps.push({
        requirement_key: key,
        kind: 'staleness',
        title: `在办 witem「${witem.title}」fulfills 的需求已不在 BOM 中`,
        detail: `witem ${witem.id} → requirement ${target.id} → ${key}`,
        severity: 'medium',
        source_ref: witem.id,
        evidence_source: `witem:${witem.id}`,
        condition_fingerprint: fingerprint({ t: 'stale-witem', id: witem.id, key }),
        evidence_fingerprint: null,
        constraint_set_id: null,
        constraint_set_hash: null,
      });
    }
  }

  return gaps;
}

function buildEvidenceInput(constraint: BomConstraint, payload: unknown): EvidenceInput {
  if (payload === undefined || payload === null) return {};
  const p = payload as { matched?: number; total?: number; value?: number };
  if (typeof p.matched === 'number' && typeof p.total === 'number') {
    return { pattern_results: { [constraint.id]: p as PatternResult } };
  }
  if (typeof p.value === 'number' && 'metric' in constraint.condition) {
    return { metrics: { [constraint.condition.metric]: p.value } };
  }
  return {};
}

// ── 约束集（独立版本化，永不进入基线 r-vb4d / r-vb2b）────────

/** 约束集内容哈希——用于条件指纹与行级版本留痕 */
export function constraintSetHash(constraints: BomConstraint[]): string {
  return fingerprint(stableStringify(constraints));
}

/** 注册约束集：同 id 同内容幂等，同 id 不同内容拒绝（不可变） */
export async function registerConstraintSet(
  ctx: OperationContext,
  input: ConstraintSetInput,
  now: string = new Date().toISOString(),
): Promise<ConstraintSetView> {
  const hash = constraintSetHash(input.items);
  const existing = await ctx.gap.getConstraintSet(input.id);
  if (existing) {
    if (existing.set_hash !== hash) {
      throw new Error(`约束集「${input.id}」已注册且内容不同——约束集不可变，请换新版本号`);
    }
    return toConstraintSetView(existing);
  }
  const record: ConstraintSetRecord = {
    set_id: input.id,
    set_hash: hash,
    constraints: input.items,
    created_at: now,
  };
  await ctx.gap.insertConstraintSet(record);
  // 并发注册同 id 异内容时 ON CONFLICT DO NOTHING：回读实际行，确保返回内容与库一致
  const stored = await ctx.gap.getConstraintSet(input.id);
  if (!stored || stored.set_hash !== hash) {
    throw new Error(`约束集「${input.id}」并发注册冲突且内容不同——约束集不可变，请换新版本号`);
  }
  return toConstraintSetView(stored);
}

function toConstraintSetView(record: ConstraintSetRecord): ConstraintSetView {
  return {
    id: record.set_id,
    hash: record.set_hash,
    item_count: record.constraints.length,
    created_at: record.created_at,
    items: record.constraints,
  };
}

export async function listConstraintSets(ctx: OperationContext): Promise<ConstraintSetView[]> {
  const sets = await ctx.gap.listConstraintSets();
  return sets.map(toConstraintSetView);
}

// @sibom r-el5e — 约束由调用方显式传入版本：缺省为空集，不复用上一次的值
async function resolveConstraintSet(ctx: OperationContext, setId: string | undefined): Promise<ConstraintInput> {
  if (!setId) return EMPTY_CONSTRAINTS; // 缺省 = 空集（不复用旧集）
  const record = await ctx.gap.getConstraintSet(setId);
  if (!record) throw new Error(`约束集不存在：${setId}`);
  return { set_id: record.set_id, set_hash: record.set_hash, constraints: record.constraints };
}

// ── 对账（增量 diff 落账）───────────────────────────────────

export interface ReconcileResult {
  bom_commit: string;
  constraint_set_id: string | null;
  constraint_set_hash: string | null;
  changed_keys: string[];
  superseded: number;
  inserted: number;
  refreshed: number;
  resolved: number;
  unchanged: number;
}

// @sibom r-gd2b — 差距不由人创建/关闭：唯一写路径是本次对照重算
// @sibom r-gd4d — 确定性探测：输入显式（基线 + 显式约束集版本，缺省空集不复用），固定三步顺序
// @sibom r-gd5e — 对账基准 = 当前确认版本（基线指针）
// @sibom r-gd6f — 判定只有一处：账本行只在此派生写入，视图只读
// @sibom r-el4d — 对账的确定性输入：基线 + 约束集 @ 版本 + 证据集，不扫工作区
// @sibom r-vb6f — 账本由基线快照、约束集与证据集重算派生：同一输入必得同一账本，清空后可完全重建
export async function reconcile(
  ctx: OperationContext,
  scope: ReconcileScope = FULL_SCOPE,
  now: string = new Date().toISOString(),
  constraintSetId?: string,
): Promise<ReconcileResult> {
  const baseline = await ctx.gap.getBaseline();
  if (!baseline) throw new Error('未设基准——请先上报 BOM 快照');
  const constraints = await resolveConstraintSet(ctx, constraintSetId);
  const openRows = await ctx.gap.getOpenRows();

  // 约束集换版：行上记录的集合 ≠ 本次集合的约束行全部重判（删除的约束 → 行 resolve；
  // severity/指纹变化 → 行 refresh；避免增量证据被 skipped 时旧判定永久滞留）
  let effectiveScope = scope;
  if (constraints.set_id !== null && scope.constraintKeys !== null) {
    const staleKeys = new Set(
      openRows
        .filter(r => r.evidence_source.startsWith('constraint:') && r.constraint_set_id !== constraints.set_id)
        .map(r => r.requirement_key),
    );
    if (staleKeys.size > 0) {
      effectiveScope = {
        ...scope,
        constraintKeys: new Set([...scope.constraintKeys, ...staleKeys]),
      };
    }
  }

  const desired = (await computeDesiredGaps(ctx, baseline.bom, constraints, effectiveScope))
    .filter(g => !(
      effectiveScope.excludeKeys?.has(g.requirement_key) &&
      g.evidence_source.startsWith('node:')
    ));
  const scopedRows = openRows.filter(r => {
    if (r.kind === 'staleness') return true;
    if (r.evidence_source.startsWith('sibom-tags:')) {
      return effectiveScope.ruleKeys === null || effectiveScope.ruleKeys.has(r.requirement_key);
    }
    if (r.evidence_source.startsWith('constraint:')) {
      return effectiveScope.constraintKeys === null || effectiveScope.constraintKeys.has(r.requirement_key);
    }
    return effectiveScope.ruleKeys === null && effectiveScope.constraintKeys === null;
  });

  const desiredByIdentity = new Map(desired.map(g => [identityOf(g), g]));
  const existingByIdentity = new Map(scopedRows.map(r => [identityOf(r), r]));

  const result: ReconcileResult = {
    bom_commit: baseline.bom_commit,
    constraint_set_id: constraints.set_id,
    constraint_set_hash: constraints.set_hash,
    changed_keys: [],
    superseded: 0,
    inserted: 0, refreshed: 0, resolved: 0, unchanged: 0,
  };

  for (const [identity, gap] of desiredByIdentity) {
    const existing = existingByIdentity.get(identity);
    if (!existing) {
      await ctx.gap.insertRow({
        id: ulid(),
        ...gap,
        bom_commit: baseline.bom_commit,
        status: 'open',
        detected_at: now,
        resolved_at: null,
        superseded_at: null,
      });
      result.inserted++;
    } else if (
      existing.evidence_fingerprint !== gap.evidence_fingerprint
      || existing.detail !== gap.detail
      || existing.condition_fingerprint !== gap.condition_fingerprint
    ) {
      await ctx.gap.refreshRow(
        existing.id, gap.detail, gap.evidence_fingerprint, now,
        gap.condition_fingerprint, gap.constraint_set_id, gap.constraint_set_hash,
      );
      result.refreshed++;
    } else {
      result.unchanged++;
    }
  }

  for (const [identity, row] of existingByIdentity) {
    if (!desiredByIdentity.has(identity)) {
      await ctx.gap.resolveRow(row.id, now);
      result.resolved++;
    }
  }

  // 账本视图级版本：按规格记录最后一次对账所用版本（含 null；行列版本始终以行为准）
  await ctx.gap.setGapState({
    last_constraint_set_id: constraints.set_id,
    last_constraint_set_hash: constraints.set_hash,
    updated_at: now,
  });

  return result;
}

// ── 基准推进（push master 即定稿 → 增量 rebase；支持分区合并 r-vb4d）──

export interface BaselineResult extends ReconcileResult {
  changed_keys: string[];
  superseded: number;
}

function assertPartitionsDisjoint(bom: BomSnapshot): void {
  const active = new Set(bom.requirements.map(r => r.key));
  const overlap = bom.draft_requirements.map(r => r.key).filter(key => active.has(key));
  if (overlap.length > 0) {
    throw new Error(`需求键同时出现在 requirements 与 draft_requirements：${[...new Set(overlap)].join(', ')}`);
  }
}

// @sibom r-vb2b — 基线只由人审确认（commit）的契约变更推进；证据上报与约束集变更不经此路径
// @sibom r-vb7g — 基线 commit 前移时按键 diff，契约版本变更（含判据摘要变化）进入探测并产出增量差距
export async function setBaseline(
  ctx: OperationContext,
  input: BomBaselineInput,
  now: string = new Date().toISOString(),
): Promise<BaselineResult> {
  const old = await ctx.gap.getBaseline();
  // 约束集只是 changed-key 重算的输入，从不写入基线（r-vb4d）
  const scopeSetId = input.constraint_set_id;

  if (!old) {
    // 首次上报：requirements 必填（spec · BomBaselineInput）；基线只含 BOM 契约
    if (input.requirements === undefined) {
      throw new Error('首次上报基线必须包含 requirements 分区');
    }
    const bom: BomSnapshot = {
      commit: input.commit,
      requirements: input.requirements,
      draft_requirements: input.draft_requirements ?? [],
    };
    assertPartitionsDisjoint(bom);
    await ctx.gap.setBaseline(bom, now);
    const r = await reconcile(ctx, FULL_SCOPE, now, scopeSetId);
    return { ...r, changed_keys: bom.requirements.map(x => x.key), superseded: 0 };
  }

  // 已有旧基线：分区合并（缺省分区沿用旧值）；commit 相同 = 同 commit 分区合并（幂等），不同 = 基线前移
  const bom: BomSnapshot = {
    commit: input.commit,
    requirements: input.requirements ?? old.bom.requirements,
    draft_requirements: input.draft_requirements ?? old.bom.draft_requirements,
  };
  const changedKeys = diffBomKeys(old.bom, bom);
  const oldKeys = [...old.bom.requirements, ...old.bom.draft_requirements].map(requirement => requirement.key);
  const newKeys = new Set([...bom.requirements, ...bom.draft_requirements].map(requirement => requirement.key));
  const deletedKeys = new Set(oldKeys.filter(key => !newKeys.has(key)));
  assertPartitionsDisjoint(bom);
  await ctx.gap.setBaseline(bom, now);
  // @sibom r-ar2b — 责任范围定义变化：旧认领作废，需求键回到可领取
  await ctx.claims.expireByKeys([...changedKeys], now);
  // @sibom r-ar4d — 契约提案经人确认：基线前移且目标需求键变化即确认（commit 即确认）
  // @sibom r-ar5e — 提案与主线确认：基线推进按变更键自动确认提案，提案不是第二写入口
  await ctx.proposals.confirmByChangedKeys(bom.commit, [...changedKeys], now);
  const openBefore = await ctx.gap.getOpenRows();
  const superseded = openBefore.filter(r => changedKeys.has(r.requirement_key)).length;
  await ctx.gap.supersedeRowsByKeys([...changedKeys], now);
  // @sibom r-gl9i — 基线迁移修剪已删除键差距；global 差距为卫生项
  const r = await reconcile(ctx, {
    ruleKeys: changedKeys,
    constraintKeys: changedKeys,
    excludeKeys: deletedKeys,
  }, now, scopeSetId);
  return { ...r, changed_keys: [...changedKeys].sort(), superseded };
}

/** 契约变更键集合：需求新增/删除/修改（含规则判据摘要变化）；draft 删除即键变化 */
function diffBomKeys(oldBom: BomSnapshot, newBom: BomSnapshot): Set<string> {
  const changed = new Set<string>();
  const oldReqs = new Map(oldBom.requirements.map(r => [r.key, r]));
  const newReqs = new Map(newBom.requirements.map(r => [r.key, r]));
  for (const [key, req] of newReqs) {
    const prev = oldReqs.get(key);
    if (!prev || stableStringify(prev) !== stableStringify(req)) changed.add(key);
  }
  for (const key of oldReqs.keys()) {
    if (!newReqs.has(key)) changed.add(key);
  }
  // draft 删除同样需要作废旧行（draft 规则不参与对账，但键身份仍需留痕）
  const oldDrafts = new Set(oldBom.draft_requirements.map(r => r.key));
  const newDrafts = new Set(newBom.draft_requirements.map(r => r.key));
  for (const key of oldDrafts) {
    if (!newDrafts.has(key) && !newReqs.has(key)) changed.add(key);
  }
  return changed;
}

// ── 证据上报（推，不是拉；增量重算 r-gl5e）────────────────────

export interface EvidenceReportResult extends ReconcileResult {
  accepted: number;
  skipped: number;
}

// @sibom r-el1a — 证据按基线版本组织：记录观测时的 baseline_commit，append-only 留痕可追溯
// @sibom r-ec1a — 证据只接收来源侧上报（代码认领/测试/检查输出），控制面不扫描工作区
// @sibom r-el2b — 证据以 source_id（constraint:{id} / sibom-tags）为锚定判据单位入账
// @sibom r-vb2b — 证据上报只写证据并重算，绝不推进基线；约束从已注册约束集解析
export async function reportEvidence(
  ctx: OperationContext,
  input: EvidenceReportInput,
  now: string = new Date().toISOString(),
): Promise<EvidenceReportResult> {
  const baseline = await ctx.gap.getBaseline();
  if (!baseline) throw new Error('未设基准——请先上报 BOM 快照');

  const items = input.items;
  const hasConstraintItem = items.some(item => item.source_id.startsWith('constraint:'));
  if (hasConstraintItem && !input.constraint_set_id) {
    throw new Error('约束证据需要 constraint_set_id：请先注册约束集再上报');
  }
  const constraints = await resolveConstraintSet(ctx, input.constraint_set_id);

  const affectedKeys = new Set<string>();
  let sibomChanged = false;
  let accepted = 0;
  let skipped = 0;

  const constraintByIdKey = new Map(
    constraints.constraints.map(c => [c.id, constraintKey(c)]),
  );

  for (const item of items) {
    const fp = fingerprint(item.payload);
    const prev = await ctx.gap.getEvidence(item.source_id);
    if (prev && prev.fingerprint === fp) {
      skipped++;
      continue;
    }
    await ctx.gap.upsertEvidence({
      source_id: item.source_id,
      payload: item.payload,
      fingerprint: fp,
      reported_at: item.reported_at ?? now,
      baseline_commit: item.baseline_commit ?? baseline.bom_commit,
    });
    accepted++;
    // 增量（r-gl5e）：constraint 项标键重算该约束；sibom-tags 项重算全部规则认领。
    // staleness 恒全量，无需标键。
    const constraintMatch = item.source_id.match(/^constraint:(.+)$/);
    if (constraintMatch) {
      affectedKeys.add(constraintByIdKey.get(constraintMatch[1]) ?? GLOBAL_KEY);
    }
    if (item.source_id === 'sibom-tags') sibomChanged = true;
  }

  if (accepted === 0) {
    return {
      bom_commit: baseline.bom_commit,
      constraint_set_id: constraints.set_id,
      constraint_set_hash: constraints.set_hash,
      changed_keys: [],
      superseded: 0,
      inserted: 0, refreshed: 0, resolved: 0, unchanged: 0,
      accepted, skipped,
    };
  }

  const scope: ReconcileScope = {
    ruleKeys: sibomChanged ? null : new Set<string>(),
    constraintKeys: affectedKeys.size > 0 ? affectedKeys : new Set<string>(),
  };
  const r = await reconcile(ctx, scope, now, input.constraint_set_id);
  return { ...r, accepted, skipped };
}

// ── 账单读取（witem 标注 + 豁免静默标记）──────────────────────

export async function listGaps(ctx: OperationContext): Promise<{
  bom_commit: string | null;
  constraint_set_id: string | null;
  constraint_set_hash: string | null;
  gaps: GapView[];
  summary: { total: number; violation: number; absence: number; staleness: number; waived: number; hygiene: number };
}> {
  const baseline = await ctx.gap.getBaseline();
  const knownKeys = new Set([
    ...(baseline?.bom.requirements ?? []),
    ...(baseline?.bom.draft_requirements ?? []),
  ].map(requirement => requirement.key));
  const state = await ctx.gap.getGapState();
  const rows = baseline ? await ctx.gap.getOpenRows() : [];
  const waivers = await ctx.gap.getWaivers();
  const now = new Date().toISOString();
  const activeWaivers = new Map<string, WaiverRecord>(
    waivers
      .filter(w => w.expires_at === null || w.expires_at > now)
      .map(w => [w.fingerprint, w]),
  );

  const witemByKey = await inProgressWitemsByKey(ctx, baseline?.bom ?? null);
  const reportedAtBySource = new Map(
    (await ctx.gap.getAllEvidence()).map(ev => [ev.source_id, ev.reported_at]),
  );

  const gaps: GapView[] = rows.map(row => {
    // 豁免指纹 = 条件指纹 + 证据源哈希（r-gd7g：判定依据或证据来源变化 → 指纹变 → 豁免失效）
    const waiverKey = fingerprint({ condition_fingerprint: row.condition_fingerprint, evidence_source: row.evidence_source });
    const waiver = activeWaivers.get(waiverKey) ?? null;
    const evidenceSourceId = evidenceSourceIdOf(row);
    return {
      ...row,
      in_progress_witem: witemByKey.get(row.requirement_key) ?? null,
      waiver: waiver ? { reason: waiver.reason, expires_at: waiver.expires_at } : null,
      evidence_reported_at: evidenceSourceId
        ? reportedAtBySource.get(evidenceSourceId) ?? null
        : null,
      hygiene: row.requirement_key === GLOBAL_KEY ||
        (baseline !== null && !knownKeys.has(row.requirement_key)),
    };
  });

  return {
    bom_commit: baseline?.bom_commit ?? null,
    constraint_set_id: state?.last_constraint_set_id ?? null,
    constraint_set_hash: state?.last_constraint_set_hash ?? null,
    gaps,
    summary: {
      total: gaps.length,
      violation: gaps.filter(g => g.kind === 'violation').length,
      absence: gaps.filter(g => g.kind === 'absence').length,
      staleness: gaps.filter(g => g.kind === 'staleness').length,
      waived: gaps.filter(g => g.waiver !== null).length,
      hygiene: gaps.filter(g => g.hygiene).length,
    },
  };
}

/** 由差距行反推证据 source_id（引擎私有知识，不外泄到观察窗）。 */
function evidenceSourceIdOf(row: GapRowRecord): string | null {
  if (row.evidence_source.startsWith('constraint:')) return row.evidence_source;
  if (row.evidence_source.startsWith('sibom-tags')) return 'sibom-tags';
  // node:/witem:/@sibom: 等无上报时间
  return null;
}

// @sibom r-gd7g — 豁免键 = (条件指纹, 证据源)：判定依据或证据源变化即重新提醒，豁免不删除差距
// @sibom r-gd8h — 处置入口只有两个：豁免签名（仅静默）与契约变更提案；无手动开闭差距入口
/** 豁免签约（r-gd7g）：按 condition_fingerprint 反查 open 行，对每行存 (条件指纹+证据源) 哈希键的豁免。返回命中行数。 */
export async function signWaiversByCondition(
  ctx: OperationContext,
  conditionFingerprint: string,
  reason: string,
  expiresAt: string | null,
): Promise<number> {
  const rows = (await ctx.gap.getOpenRows())
    .filter(r => r.condition_fingerprint === conditionFingerprint);
  const createdAt = new Date().toISOString();
  for (const row of rows) {
    await ctx.gap.upsertWaiver({
      fingerprint: fingerprint({ condition_fingerprint: row.condition_fingerprint, evidence_source: row.evidence_source }),
      reason,
      expires_at: expiresAt,
      created_at: createdAt,
    });
  }
  return rows.length;
}

// ── 对照视图证据聚合（目检数据，不产差距条目）─────────────────

export async function buildEvidenceScene(
  ctx: OperationContext,
  requirementKey: string,
): Promise<EvidenceScene> {
  const scene: EvidenceScene = {
    requirement_key: requirementKey,
    files: [],
    runs: [],
    sibs_nodes: [],
  };
  const baseline = await ctx.gap.getBaseline();
  const evidence = await ctx.gap.getAllEvidence();
  // 对照视图取约束定义：以当前注册版本（最近注册的约束集）为源，不依赖 gap_state
  const setRecords = await ctx.gap.listConstraintSets();
  const currentSet = setRecords.at(-1);
  const constraintById = new Map<string, BomConstraint>();
  for (const constraint of currentSet?.constraints ?? []) constraintById.set(constraint.id, constraint);

  const requirement = baseline
    ? [...baseline.bom.requirements, ...baseline.bom.draft_requirements].find(r => r.key === requirementKey)
    : undefined;
  const ruleIds = new Set((requirement?.rules ?? []).map(rule => rule.id));
  // files 由当前 sibom-tags 证据与基线规则归属求交派生；无基线时为空
  const sibomEv = evidence.find(ev => ev.source_id === 'sibom-tags');
  if (sibomEv && ruleIds.size > 0) {
    const claims = (sibomEv.payload as { rules?: Array<{ id: string; file: string }> }).rules ?? [];
    for (const claim of claims) {
      if (!ruleIds.has(claim.id)) continue;
      scene.files.push({ path: claim.file, sibom_tag: `@sibom ${claim.id}` });
    }
  }

  for (const ev of evidence) {
    const constraintMatch = ev.source_id.match(/^constraint:(.+)$/);
    if (constraintMatch && baseline) {
      const constraint = constraintById.get(constraintMatch[1]);
      if (!constraint || constraintKey(constraint) !== requirementKey) continue;
      const evidenceInput = buildEvidenceInput(constraint, ev.payload);
      const result = await evaluateConstraint(constraint, evidenceInput, ctx);
      scene.runs.push({
        label: `${constraint.title}（${constraint.id}）`,
        result: result.satisfied === true ? 'pass' : 'fail',
        reported_at: ev.reported_at,
      });
    }
  }

  const requirementNodes = await ctx.nodes.getByType('requirement') as RequirementNode[];
  const reqNode = requirementNodes.find(n => n.source_detail === requirementKey);
  if (reqNode) {
    scene.sibs_nodes.push({ id: reqNode.id, type: reqNode.type, title: reqNode.title });
    const edges = [
      ...await ctx.edges.getBySource(reqNode.id),
      ...await ctx.edges.getByTarget(reqNode.id),
    ];
    const seen = new Set([reqNode.id]);
    for (const edge of edges) {
      const otherId = edge.source_id === reqNode.id ? edge.target_id : edge.source_id;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const node = await ctx.nodes.getById(otherId);
      if (!node || (node.type !== 'decision' && node.type !== 'knowledge')) continue;
      scene.sibs_nodes.push({ id: node.id, type: node.type, title: node.title });
    }
  }

  return scene;
}

async function inProgressWitemsByKey(
  ctx: OperationContext,
  bom: BomSnapshot | null,
): Promise<Map<string, { id: string; title: string }>> {
  const map = new Map<string, { id: string; title: string }>();
  if (!bom) return map;
  const witems = await ctx.nodes.getByTypeAndStatus('witem', 'active') as WitemNode[];
  for (const witem of witems) {
    const edges = await ctx.edges.getBySource(witem.id);
    for (const edge of edges.filter(e => e.relation === 'fulfills')) {
      const target = await ctx.nodes.getById(edge.target_id);
      if (!target || target.type !== 'requirement') continue;
      const key = (target as RequirementNode).source_detail;
      if (key && !map.has(key)) map.set(key, { id: witem.id, title: witem.title });
    }
  }
  return map;
}
