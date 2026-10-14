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
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  /** 身份三元组之证据源（r-gl3c）：constraint:{id} / sibom-tags:{ruleId} / @bom:{key} / @sibom:{ruleId} / node:{id} / witem:{id} */
  evidence_source: string;
  condition_fingerprint: string;
  evidence_fingerprint: string | null;
}

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
}

const FULL_SCOPE: ReconcileScope = { ruleKeys: null, constraintKeys: null };

async function computeDesiredGaps(
  ctx: OperationContext,
  bom: BomSnapshot,
  scope: ReconcileScope,
): Promise<DesiredGap[]> {
  const gaps: DesiredGap[] = [];
  const bomKeys = new Set(bom.requirements.map(r => r.key));
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
        condition_fingerprint: fingerprint({ t: 'rule', key: req.key, rule: rule.id, title: rule.title }),
        evidence_fingerprint: sibomEv?.fingerprint ?? null,
      });
    }
  }

  // Step 2: 约束 vs 证据 → 违约 / 缺失
  for (const constraint of bom.constraints) {
    const key = constraintKey(constraint);
    if (!constraintInScope(key)) continue;
    if (key !== GLOBAL_KEY && !bomKeys.has(key)) continue; // 键失配 → Step 3 staleness
    const ev = await ctx.gap.getEvidence(`constraint:${constraint.id}`);
    const evidence = buildEvidenceInput(constraint, ev?.payload);
    const result = await evaluateConstraint(constraint, evidence, ctx);
    if (result.satisfied === true) continue;
    const conditionFp = fingerprint({ t: 'constraint', id: constraint.id, condition: constraint.condition });
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
      });
    }
  }

  // Step 3: 需求过时检测 → staleness（结构性对照，始终全量：廉价）
  for (const constraint of bom.constraints) {
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
        condition_fingerprint: fingerprint({ t: 'stale-constraint', id: constraint.id, key }),
        evidence_fingerprint: null,
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
    });
  }

  const tagsEv = await ctx.gap.getEvidence('bom-tags');
  if (tagsEv) {
    const tags = ((tagsEv.payload as { tags?: Array<{ key: string; file: string }> }).tags ?? []);
    const staleByKey = new Map<string, string[]>();
    for (const tag of tags) {
      if (bomKeys.has(tag.key)) continue;
      const files = staleByKey.get(tag.key) ?? [];
      files.push(tag.file);
      staleByKey.set(tag.key, files);
    }
    for (const [key, files] of staleByKey) {
      gaps.push({
        requirement_key: key,
        kind: 'staleness',
        title: `代码 @bom 标签指向的需求键不在 BOM 中`,
        detail: files.join(', '),
        severity: 'medium',
        source_ref: `@bom:${key}`,
        evidence_source: `@bom:${key}`,
        condition_fingerprint: fingerprint({ t: 'stale-tag', key }),
        evidence_fingerprint: fingerprint(files),
      });
    }
  }

  if (sibomEv) {
    const rules = ((sibomEv.payload as { rules?: Array<{ id: string; file: string }> }).rules ?? []);
    const knownRules = new Set(bom.requirements.flatMap(r => (r.rules ?? []).map(x => x.id)));
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

// ── 对账（增量 diff 落账）───────────────────────────────────

export interface ReconcileResult {
  bom_commit: string;
  inserted: number;
  refreshed: number;
  resolved: number;
  unchanged: number;
}

export async function reconcile(
  ctx: OperationContext,
  scope: ReconcileScope = FULL_SCOPE,
  now: string = new Date().toISOString(),
): Promise<ReconcileResult> {
  const baseline = await ctx.gap.getBaseline();
  if (!baseline) throw new Error('未设基准——请先上报 BOM 快照');

  const desired = await computeDesiredGaps(ctx, baseline.bom, scope);
  const openRows = await ctx.gap.getOpenRows();
  const scopedRows = openRows.filter(r => {
    if (r.kind === 'staleness') return true;
    if (r.evidence_source.startsWith('sibom-tags:')) {
      return scope.ruleKeys === null || scope.ruleKeys.has(r.requirement_key);
    }
    if (r.evidence_source.startsWith('constraint:')) {
      return scope.constraintKeys === null || scope.constraintKeys.has(r.requirement_key);
    }
    return scope.ruleKeys === null && scope.constraintKeys === null;
  });

  const desiredByIdentity = new Map(desired.map(g => [identityOf(g), g]));
  const existingByIdentity = new Map(scopedRows.map(r => [identityOf(r), r]));

  const result: ReconcileResult = {
    bom_commit: baseline.bom_commit, inserted: 0, refreshed: 0, resolved: 0, unchanged: 0,
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
    } else if (existing.evidence_fingerprint !== gap.evidence_fingerprint || existing.detail !== gap.detail) {
      await ctx.gap.refreshRow(existing.id, gap.detail, gap.evidence_fingerprint, now);
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

  return result;
}

// ── 基准推进（push master 即定稿 → 增量 rebase；支持分区合并 r-vb4d）──

export interface BaselineResult extends ReconcileResult {
  changed_keys: string[];
  superseded: number;
}

export async function setBaseline(
  ctx: OperationContext,
  input: BomBaselineInput,
  now: string = new Date().toISOString(),
): Promise<BaselineResult> {
  const old = await ctx.gap.getBaseline();

  if (!old) {
    // 首次上报：缺省分区视为空分区——sync（requirements）与采集器（constraints）任一先到均可建基线，
    // 另一分区随后续同 commit 分区合并补齐（r-vb4d）
    const bom: BomSnapshot = {
      commit: input.commit,
      requirements: input.requirements ?? [],
      constraints: input.constraints ?? [],
    };
    await ctx.gap.setBaseline(bom, now);
    const r = await reconcile(ctx, FULL_SCOPE, now);
    return { ...r, changed_keys: bom.requirements.map(x => x.key), superseded: 0 };
  }

  // 已有旧基线：分区合并（缺省分区沿用旧值）；commit 相同 = 同 commit 分区合并（幂等），不同 = 基线前移
  const bom: BomSnapshot = {
    commit: input.commit,
    requirements: input.requirements ?? old.bom.requirements,
    constraints: input.constraints ?? old.bom.constraints,
  };
  await ctx.gap.setBaseline(bom, now);

  const changedKeys = diffBomKeys(old.bom, bom);
  const openBefore = await ctx.gap.getOpenRows();
  const superseded = openBefore.filter(r => changedKeys.has(r.requirement_key)).length;
  await ctx.gap.supersedeRowsByKeys([...changedKeys], now);
  const r = await reconcile(ctx, { ruleKeys: changedKeys, constraintKeys: changedKeys }, now);
  return { ...r, changed_keys: [...changedKeys].sort(), superseded };
}

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
  const byKey = (list: BomConstraint[]) => {
    const m = new Map<string, string>();
    for (const c of list) {
      const k = constraintKey(c);
      m.set(k, (m.get(k) ?? '') + stableStringify(c));
    }
    return m;
  };
  const oldCons = byKey(oldBom.constraints);
  const newCons = byKey(newBom.constraints);
  for (const [key, sig] of newCons) {
    if (oldCons.get(key) !== sig) changed.add(key);
  }
  for (const key of oldCons.keys()) {
    if (!newCons.has(key)) changed.add(key);
  }
  return changed;
}

// ── 证据上报（推，不是拉；增量重算 r-gl5e）────────────────────

export interface EvidenceReportResult extends ReconcileResult {
  accepted: number;
  skipped: number;
}

export async function reportEvidence(
  ctx: OperationContext,
  input: EvidenceReportInput,
  now: string = new Date().toISOString(),
): Promise<EvidenceReportResult> {
  const baseline = await ctx.gap.getBaseline();
  if (!baseline) throw new Error('未设基准——请先上报 BOM 快照');

  const items = input.items;
  const affectedKeys = new Set<string>();
  let sibomChanged = false;
  let accepted = 0;
  let skipped = 0;

  const constraintByIdKey = new Map(
    baseline.bom.constraints.map(c => [c.id, constraintKey(c)]),
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
    // 增量（r-gl5e）：constraint 项标键重算该约束；sibom-tags 项重算全部规则认领；
    // bom-tags 项只影响 staleness（恒全量）。staleness 恒全量，无需标键。
    const constraintMatch = item.source_id.match(/^constraint:(.+)$/);
    if (constraintMatch) {
      affectedKeys.add(constraintByIdKey.get(constraintMatch[1]) ?? GLOBAL_KEY);
    }
    if (item.source_id === 'sibom-tags') sibomChanged = true;
  }

  if (accepted === 0) {
    return {
      bom_commit: baseline.bom_commit,
      inserted: 0, refreshed: 0, resolved: 0, unchanged: 0,
      accepted, skipped,
    };
  }

  const scope: ReconcileScope = {
    ruleKeys: sibomChanged ? null : new Set<string>(),
    constraintKeys: affectedKeys.size > 0 ? affectedKeys : new Set<string>(),
  };
  const r = await reconcile(ctx, scope, now);
  return { ...r, accepted, skipped };
}

// ── 账单读取（witem 标注 + 豁免静默标记）──────────────────────

export async function listGaps(ctx: OperationContext): Promise<{
  bom_commit: string | null;
  gaps: GapView[];
  summary: { total: number; violation: number; absence: number; staleness: number; waived: number };
}> {
  const baseline = await ctx.gap.getBaseline();
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
    };
  });

  return {
    bom_commit: baseline?.bom_commit ?? null,
    gaps,
    summary: {
      total: gaps.length,
      violation: gaps.filter(g => g.kind === 'violation').length,
      absence: gaps.filter(g => g.kind === 'absence').length,
      staleness: gaps.filter(g => g.kind === 'staleness').length,
      waived: gaps.filter(g => g.waiver !== null).length,
    },
  };
}

/** 由差距行反推证据 source_id（引擎私有知识，不外泄到观察窗）。 */
function evidenceSourceIdOf(row: GapRowRecord): string | null {
  if (row.evidence_source.startsWith('constraint:')) return row.evidence_source;
  if (row.evidence_source.startsWith('sibom-tags')) return 'sibom-tags';
  if (row.evidence_source.startsWith('@bom:')) return 'bom-tags';
  // node:/witem:/@sibom: 等无上报时间
  return null;
}

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

  for (const ev of evidence) {
    if (ev.source_id === 'bom-tags') {
      const tags = (ev.payload as { tags?: Array<{ key: string; file: string }> }).tags ?? [];
      for (const tag of tags) {
        if (tag.key !== requirementKey) continue;
        scene.files.push({ path: tag.file, bom_tag: `@bom ${tag.key}` });
      }
      continue;
    }
    const constraintMatch = ev.source_id.match(/^constraint:(.+)$/);
    if (constraintMatch && baseline) {
      const constraint = baseline.bom.constraints.find(c => c.id === constraintMatch[1]);
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
