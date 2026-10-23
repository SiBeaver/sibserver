import { createHash } from 'node:crypto';
import type {
  BomConstraint,
  BomRequirement,
  BomSnapshot,
  EvidenceRecord,
  FactBoundary,
  GapIdentity,
  GapRowRecord,
  OperationContext,
  Workpack,
  WorkpackList,
} from '@sibeaver/core';

// ============================================================
// 工作包派生 — 差距账本 → 可执行工作包（只读）
// 工作包是派生视图，不落库；claim/lease 是唯一运行时状态（r-ar1a）。
// ============================================================

function gapIdentityOf(row: GapRowRecord): GapIdentity {
  return {
    requirement_key: row.requirement_key,
    kind: row.kind,
    evidence_source: row.evidence_source,
  };
}

function identityKey(identity: GapIdentity): string {
  return `${identity.requirement_key}|${identity.kind}|${identity.evidence_source}`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function normalizeDeps(key: string, deps: string[] | undefined): string[] {
  const domain = key.split('/')[0];
  const normalized = (deps ?? [])
    .map(dep => (dep.includes('/') ? dep : `${domain}/${dep}`))
    .filter(dep => dep !== key);
  return [...new Set(normalized)].sort();
}

function scopeOfConstraint(constraint: BomConstraint): string | null {
  const condition = constraint.condition;
  if (condition === null || typeof condition !== 'object' || !('scope' in condition)) return null;
  const scope = (condition as { scope?: unknown }).scope;
  return asString(scope);
}

// @sibom r-bc2b — 事实边界由代码认领与约束 scope 显式派生；无 scope 时标记未解析
function deriveFactBoundary(
  requirementKey: string,
  requirement: BomRequirement | undefined,
  gaps: GapRowRecord[],
  bom: BomSnapshot,
  evidence: EvidenceRecord[],
): FactBoundary {
  const writable = new Set<string>();
  const sources = new Set<string>();

  const bomTags = evidence.find(item => item.source_id === 'bom-tags');
  if (bomTags) {
    const payload = bomTags.payload as { tags?: Array<{ key?: unknown; file?: unknown }> } | null;
    for (const tag of payload?.tags ?? []) {
      if (tag.key !== requirementKey) continue;
      const file = asString(tag.file);
      if (file) {
        writable.add(file);
        sources.add('bom-tags');
      }
    }
  }

  const sibomTags = evidence.find(item => item.source_id === 'sibom-tags');
  if (sibomTags) {
    const ruleIds = new Set((requirement?.rules ?? []).map(rule => rule.id));
    const payload = sibomTags.payload as { rules?: Array<{ id?: unknown; file?: unknown }> } | null;
    for (const rule of payload?.rules ?? []) {
      if (typeof rule.id !== 'string' || !ruleIds.has(rule.id)) continue;
      const file = asString(rule.file);
      if (file) {
        writable.add(file);
        sources.add('sibom-tags');
      }
    }
  }

  const referenced = new Set<string>();
  for (const gap of gaps) {
    const match = /^constraint:(.+)$/.exec(gap.evidence_source);
    if (match) referenced.add(match[1]);
  }
  for (const constraint of bom.constraints) {
    const belongs = constraint.requirement_key === requirementKey;
    const referencedByGap = referenced.has(constraint.id);
    if (!belongs && !(referencedByGap && constraint.requirement_key === undefined)) continue;
    const scope = scopeOfConstraint(constraint);
    if (scope) {
      writable.add(scope);
      sources.add(`constraint:${constraint.id}`);
    }
  }

  const scopes = [...writable].sort();
  return {
    writable: scopes,
    status: scopes.length > 0 ? 'derived' : 'unresolved',
    sources: [...sources].sort(),
  };
}

function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/\/+$/, '');
}

function scopePrefix(scope: string): string {
  const normalized = normalizeScope(scope);
  const wildcard = normalized.search(/[*?]/);
  return wildcard === -1 ? normalized : normalized.slice(0, wildcard).replace(/\/+$/, '');
}

function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  if (a === b) return true;
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
  const prefixA = scopePrefix(a);
  const prefixB = scopePrefix(b);
  return prefixA !== '' && prefixB !== '' && (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA));
}

function boundariesOverlap(left: FactBoundary, right: FactBoundary): boolean {
  return left.writable.some(a => right.writable.some(b => scopesOverlap(a, b)));
}

// @sibom r-wp2b — 身份 = 基线 + 责任差距身份集合 + 事实边界集合的确定性摘要
function workpackId(
  baseline: string,
  requirementKeys: string[],
  gaps: GapIdentity[],
  writable: string[],
): string {
  const canonical = [
    baseline,
    ...requirementKeys.slice().sort(),
    ...gaps.map(identityKey).sort(),
    ...writable.slice().sort(),
  ].join('\n');
  return `wp_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

// @sibom r-wp4d — 依赖未满足进入等待；边界相交不得同组
function assignParallelGroups(workpacks: Workpack[]): void {
  const groups: Workpack[][] = [];
  const ready = workpacks
    .filter(wp => wp.blocked_by.length === 0 && wp.boundary.fact_boundary.status === 'derived')
    .sort((a, b) => a.requirement_keys[0].localeCompare(b.requirement_keys[0]));

  for (const workpack of ready) {
    const group = groups.find(members =>
      members.every(other => !boundariesOverlap(workpack.boundary.fact_boundary, other.boundary.fact_boundary)),
    );
    if (group) {
      group.push(workpack);
      workpack.parallel_group = groups.indexOf(group);
    } else {
      workpack.parallel_group = groups.length;
      groups.push([workpack]);
    }
  }
}

// @sibom r-wp1a — 工作包由差距账本确定性派生，可随差距重算重建
// @sibom r-wp3c — 业务边界：一个工作包负责互斥的需求键集合
// @sibom r-wp5e — 验收判据：重算差距后责任差距消失
// @sibom r-bc1a — 边界契约随工作包下发，机器可读
export async function listWorkpacks(ctx: OperationContext): Promise<WorkpackList> {
  const baseline = await ctx.gap.getBaseline();
  if (!baseline) {
    return {
      baseline: null,
      workpacks: [],
      summary: { total: 0, ready: 0, blocked: 0, unresolved_boundary: 0 },
    };
  }

  const rows = await ctx.gap.getOpenRows();
  const evidence = await ctx.gap.getAllEvidence();
  const requirementByKey = new Map(baseline.bom.requirements.map(req => [req.key, req]));

  const gapsByKey = new Map<string, GapRowRecord[]>();
  for (const row of rows) {
    const list = gapsByKey.get(row.requirement_key) ?? [];
    list.push(row);
    gapsByKey.set(row.requirement_key, list);
  }

  const workpacks: Workpack[] = [];
  for (const [key, gaps] of [...gapsByKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const requirement = requirementByKey.get(key);
    const deps = normalizeDeps(key, requirement?.deps);
    const blockedBy = deps.filter(dep => gapsByKey.has(dep));
    const factBoundary = deriveFactBoundary(key, requirement, gaps, baseline.bom, evidence);
    const identities = gaps.map(gapIdentityOf).sort((a, b) => identityKey(a).localeCompare(identityKey(b)));
    const sortedGaps = gaps.slice().sort((a, b) =>
      identityKey(gapIdentityOf(a)).localeCompare(identityKey(gapIdentityOf(b))),
    );

    workpacks.push({
      id: workpackId(baseline.bom_commit, [key], identities, factBoundary.writable),
      baseline: baseline.bom_commit,
      title: `${requirement?.title ?? key}（${gaps.length} 项差距）`,
      requirement_keys: [key],
      gaps: sortedGaps.map(row => ({
        requirement_key: row.requirement_key,
        kind: row.kind,
        evidence_source: row.evidence_source,
        title: row.title,
        severity: row.severity,
      })),
      deps,
      blocked_by: blockedBy,
      parallel_group: blockedBy.length > 0 ? -1 : -2,
      boundary: {
        responsibility: [key],
        contract_subtree: key,
        fact_boundary: factBoundary,
        acceptance: {
          type: 'gap-recompute',
          requirement_keys: [key],
          gap_identities: identities,
        },
        escalation: [
          '契约变更经提案与人确认',
          '事实边界放宽须人确认',
          '越界写入判失败',
        ],
      },
    });
  }

  assignParallelGroups(workpacks);

  return {
    baseline: baseline.bom_commit,
    workpacks,
    summary: {
      total: workpacks.length,
      ready: workpacks.filter(wp => wp.parallel_group >= 0).length,
      blocked: workpacks.filter(wp => wp.blocked_by.length > 0).length,
      unresolved_boundary: workpacks.filter(wp => wp.boundary.fact_boundary.status === 'unresolved').length,
    },
  };
}
