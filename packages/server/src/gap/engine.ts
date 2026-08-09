import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import type { OperationContext } from '../operations/context.js';
import type { RequirementNode, GoalNode } from '../nodes/types.js';
import type { EvidenceInput, PatternResult } from '../constraints/types.js';
import { evaluateConstraint } from '../policies/constraint-evaluator.js';
import type {
  BomSnapshot,
  BomConstraint,
  BomRequirement,
  EvidenceItemInput,
  EvidenceScene,
  GapRowRecord,
  GapView,
  WaiverRecord,
} from './types.js';

// ============================================================
// Gap 引擎 — 三方对账：BOM@commit（应然）/ 证据（实然）/ 在办 goal（标注）
//
// 差距只能由对照计算自动发现，不可手动创建/关闭；
// 差距消失的唯一路径是下轮对账时证据满足条件（豁免仅静默）。
// ============================================================

const GLOBAL_KEY = '(global)';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface DesiredGap {
  requirement_key: string;
  kind: GapRowRecord['kind'];
  title: string;
  detail: string;
  severity: string;
  source_ref: string;
  condition_fingerprint: string;
  evidence_fingerprint: string | null;
}

function identityOf(g: Pick<DesiredGap, 'requirement_key' | 'kind' | 'source_ref'>): string {
  return `${g.requirement_key}\u0000${g.kind}\u0000${g.source_ref}`;
}

function constraintKey(c: BomConstraint): string {
  return c.requirement_key ?? GLOBAL_KEY;
}

// ── 三源计算（纯函数部分 + sibs_query/goal 读图谱）─────────────

async function computeDesiredGaps(
  ctx: OperationContext,
  bom: BomSnapshot,
  scope: Set<string> | null,
): Promise<DesiredGap[]> {
  const gaps: DesiredGap[] = [];
  const bomKeys = new Set(bom.requirements.map(r => r.key));
  const inScope = (key: string) => scope === null || scope.has(key);

  // Step 1: 规则认领对账 → 缺失（BOM 业务规则无人 @sibom 认领）
  const sibomEv = await ctx.gap.getEvidence('sibom-tags');
  const claimedRules = new Set(
    (sibomEv?.payload as { rules?: Array<{ id: string }> } | undefined)?.rules?.map(r => r.id) ?? [],
  );
  for (const req of bom.requirements) {
    if (!inScope(req.key)) continue;
    for (const rule of req.rules ?? []) {
      if (claimedRules.has(rule.id)) continue;
      gaps.push({
        requirement_key: req.key,
        kind: 'absence',
        title: `规则「${rule.title}」无人认领`,
        detail: 'BOM 业务规则没有 @sibom 认领（代码未自报归属）',
        severity: 'medium',
        source_ref: rule.id,
        condition_fingerprint: fingerprint({ t: 'rule', key: req.key, rule: rule.id, title: rule.title }),
        evidence_fingerprint: sibomEv?.fingerprint ?? null,
      });
    }
  }

  // Step 2: 约束 vs 证据 → 违约 / 缺失
  for (const constraint of bom.constraints) {
    const key = constraintKey(constraint);
    if (!inScope(key)) continue;
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
        condition_fingerprint: fingerprint({ t: 'stale-constraint', id: constraint.id, key }),
        evidence_fingerprint: null,
      });
    }
  }

  const requirementNodes = await ctx.nodes.getByType('requirement') as RequirementNode[];
  for (const node of requirementNodes) {
    const key = node.source_detail;
    if (!key || bomKeys.has(key)) continue;
    gaps.push({
      requirement_key: key,
      kind: 'staleness',
      title: `sibs 需求节点「${node.title}」的需求键不在 BOM 中`,
      detail: `node ${node.id} → ${key}`,
      severity: 'medium',
      source_ref: node.id,
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
        condition_fingerprint: fingerprint({ t: 'stale-sibom', rule: ruleId }),
        evidence_fingerprint: fingerprint(files),
      });
    }
  }

  const goals = await ctx.nodes.getByTypeAndStatus('goal', 'active') as GoalNode[];
  for (const goal of goals) {
    const edges = await ctx.edges.getBySource(goal.id);
    for (const edge of edges.filter(e => e.relation === 'fulfills')) {
      const target = await ctx.nodes.getById(edge.target_id);
      if (!target || target.type !== 'requirement') continue;
      const key = (target as RequirementNode).source_detail;
      if (!key || bomKeys.has(key)) continue;
      gaps.push({
        requirement_key: key,
        kind: 'staleness',
        title: `在办 goal「${goal.title}」fulfills 的需求已不在 BOM 中`,
        detail: `goal ${goal.id} → requirement ${target.id} → ${key}`,
        severity: 'medium',
        source_ref: goal.id,
        condition_fingerprint: fingerprint({ t: 'stale-goal', id: goal.id, key }),
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
  scope: Set<string> | null = null,
  now: string = new Date().toISOString(),
): Promise<ReconcileResult> {
  const baseline = await ctx.gap.getBaseline();
  if (!baseline) throw new Error('No baseline set — report BOM snapshot first');

  const desired = await computeDesiredGaps(ctx, baseline.bom, scope);
  const openRows = await ctx.gap.getOpenRows();
  const scopedRows = openRows.filter(r =>
    (scope === null || scope.has(r.requirement_key) || r.kind === 'staleness'),
  );

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

// ── 基准前移（push master 即定稿 → 增量 rebase）──────────────

export interface BaselineResult extends ReconcileResult {
  changed_keys: string[];
  superseded: number;
}

export async function setBaseline(
  ctx: OperationContext,
  bom: BomSnapshot,
  now: string = new Date().toISOString(),
): Promise<BaselineResult> {
  const old = await ctx.gap.getBaseline();
  await ctx.gap.setBaseline(bom, now);

  if (!old) {
    const r = await reconcile(ctx, null, now);
    return { ...r, changed_keys: bom.requirements.map(x => x.key), superseded: 0 };
  }

  const changedKeys = diffBomKeys(old.bom, bom);
  const openBefore = await ctx.gap.getOpenRows();
  const superseded = openBefore.filter(r => changedKeys.has(r.requirement_key)).length;
  await ctx.gap.supersedeRowsByKeys([...changedKeys], now);
  const r = await reconcile(ctx, changedKeys, now);
  return { ...r, changed_keys: [...changedKeys].sort(), superseded };
}

function diffBomKeys(oldBom: BomSnapshot, newBom: BomSnapshot): Set<string> {
  const changed = new Set<string>();
  const oldReqs = new Map(oldBom.requirements.map(r => [r.key, r]));
  const newReqs = new Map(newBom.requirements.map(r => [r.key, r]));
  for (const [key, req] of newReqs) {
    const prev = oldReqs.get(key);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(req)) changed.add(key);
  }
  for (const key of oldReqs.keys()) {
    if (!newReqs.has(key)) changed.add(key);
  }
  const byKey = (list: BomConstraint[]) => {
    const m = new Map<string, string>();
    for (const c of list) {
      const k = constraintKey(c);
      m.set(k, (m.get(k) ?? '') + JSON.stringify(c));
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

// ── 证据上报（推，不是拉）────────────────────────────────────

export interface EvidenceReportResult extends ReconcileResult {
  accepted: number;
  skipped: number;
}

export async function reportEvidence(
  ctx: OperationContext,
  items: EvidenceItemInput[],
  now: string = new Date().toISOString(),
): Promise<EvidenceReportResult> {
  const baseline = await ctx.gap.getBaseline();
  if (!baseline) throw new Error('No baseline set — report BOM snapshot first');

  const affectedKeys = new Set<string>();
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
    });
    accepted++;
    const constraintMatch = item.source_id.match(/^constraint:(.+)$/);
    if (constraintMatch) {
      affectedKeys.add(constraintByIdKey.get(constraintMatch[1]) ?? GLOBAL_KEY);
    }
    // bom-tags / sibom-tags 等其他证据源影响 staleness 与规则认领，reconcile 时始终全量重查
  }

  if (accepted === 0) {
    return {
      bom_commit: baseline.bom_commit,
      inserted: 0, refreshed: 0, resolved: 0, unchanged: 0,
      accepted, skipped,
    };
  }

  const r = await reconcile(ctx, affectedKeys.size > 0 ? affectedKeys : null, now);
  return { ...r, accepted, skipped };
}

// ── 账单读取（goal 标注 + 豁免静默标记）──────────────────────

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

  const goalByKey = await inProgressGoalsByKey(ctx, baseline?.bom ?? null);
  const reportedAtBySource = new Map(
    (await ctx.gap.getAllEvidence()).map(ev => [ev.source_id, ev.reported_at]),
  );
  const constraintIds = new Set((baseline?.bom.constraints ?? []).map(c => c.id));

  const gaps: GapView[] = rows.map(row => {
    const waiver = activeWaivers.get(row.condition_fingerprint) ?? null;
    return {
      ...row,
      in_progress_goal: goalByKey.get(row.requirement_key) ?? null,
      waiver: waiver ? { reason: waiver.reason, expires_at: waiver.expires_at } : null,
      evidence_reported_at: row.evidence_fingerprint === null
        ? null
        : reportedAtBySource.get(evidenceSourceIdOf(row, constraintIds)) ?? null,
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
function evidenceSourceIdOf(row: GapRowRecord, constraintIds: Set<string>): string {
  if (row.source_ref.startsWith('@bom:')) return 'bom-tags';
  if (constraintIds.has(row.source_ref)) return `constraint:${row.source_ref}`;
  return 'sibom-tags';
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

async function inProgressGoalsByKey(
  ctx: OperationContext,
  bom: BomSnapshot | null,
): Promise<Map<string, { id: string; title: string }>> {
  const map = new Map<string, { id: string; title: string }>();
  if (!bom) return map;
  const goals = await ctx.nodes.getByTypeAndStatus('goal', 'active') as GoalNode[];
  for (const goal of goals) {
    const edges = await ctx.edges.getBySource(goal.id);
    for (const edge of edges.filter(e => e.relation === 'fulfills')) {
      const target = await ctx.nodes.getById(edge.target_id);
      if (!target || target.type !== 'requirement') continue;
      const key = (target as RequirementNode).source_detail;
      if (key && !map.has(key)) map.set(key, { id: goal.id, title: goal.title });
    }
  }
  return map;
}
