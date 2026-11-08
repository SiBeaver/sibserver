import { ulid } from 'ulidx';
import { DOMAIN_FACT_TYPES, PROPOSAL_ONLY_FACT_TYPES, toProposalView } from '@sibeaver/core';
import type {
  BoundaryDeclaration,
  ClaimCreateInput,
  ClaimNarrowInput,
  ClaimReleaseInput,
  ClaimReportInput,
  ClaimRevokeInput,
  ClaimRenewInput,
  ClaimStatus,
  ContractProposalInput,
  FactType,
  OperationContext,
  ProposalRecord,
  ProposalView,
  ResponsibilityClaimRecord,
} from '@sibeaver/core';
import { fingerprint } from '../gap/engine.js';

// ============================================================
// 责任认领（claims）— 边界声明随认领提交，互斥按需求键（组织层）
// 控制面只登记与校验，不派发、不指令、不中断。
// ============================================================

export class ClaimError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = 'ClaimError';
  }
}

function leaseSeconds(): number {
  const raw = Number(process.env.CLAIM_LEASE_SECONDS ?? process.env.WORKPACK_LEASE_SECONDS ?? '600');
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

function normalizeKeys(keys: string[]): string[] {
  return [...new Set(keys.map(key => key.trim()).filter(key => key.length > 0))].sort();
}

function validateBoundary(domain: ClaimCreateInput['domain'], boundary: BoundaryDeclaration): void {
  const allowed = new Set<FactType>(DOMAIN_FACT_TYPES[domain]);
  const invalid = boundary.fact_types
    .map(fact => fact.type)
    .filter(type => !allowed.has(type));
  if (invalid.length > 0) {
    throw new ClaimError(`事实类型不属于${domain === 'build' ? '构建域' : '运行域'}：${[...new Set(invalid)].join(', ')}`, 400);
  }
}

function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/\/+$/, '');
}

function scopePrefix(scope: string): string {
  const normalized = normalizeScope(scope);
  const wildcard = normalized.search(/[*?]/);
  return wildcard === -1 ? normalized : normalized.slice(0, wildcard).replace(/\/+$/, '');
}

function scopeContains(outer: string, inner: string): boolean {
  const a = normalizeScope(outer);
  const b = normalizeScope(inner);
  if (a === b) return true;
  if (b.startsWith(`${a}/`)) return true;
  const prefix = scopePrefix(a);
  return prefix !== '' && (b === prefix || b.startsWith(`${prefix}/`));
}

function matchFact(claim: ResponsibilityClaimRecord, factType: FactType | undefined, path: string): FactType | null {
  for (const fact of claim.boundary.fact_types) {
    if (factType !== undefined && fact.type !== factType) continue;
    if (fact.scopes.some(scope => scopeContains(scope, path))) return fact.type;
  }
  return null;
}

export interface ClaimReportResult {
  ok: boolean;
  out_of_scope: string[];
  proposal_only: string[];
  changed_facts: ClaimReportInput['changed_facts'];
  evidence_source: string;
}

// @sibom r-bc1a — 每个责任认领携带一份边界声明，结构化提交并由控制面登记
// @sibom r-bc2b — 事实边界在域级事实类型内收敛；未声明的事实不在可写范围内
// @sibom r-wp3c — 责任范围以需求键集合表达；任一时刻同一需求键最多一个活跃认领
// @sibom r-ar1a — 编排层按责任范围声明占用，控制面登记认领并建立带有效期的租约
// @sibom r-ar3c — 认领冲突按先到先得；事实边界相交不构成认领准入限制
// @sibom r-ax3c — 预授权随认领记录并可查询；执行由 harness 自检
// @sibom r-xs2b — 认领携带会话引用定位，不复制会话内容
export async function createClaim(
  ctx: OperationContext,
  input: ClaimCreateInput,
): Promise<ResponsibilityClaimRecord> {
  const now = new Date().toISOString();
  await ctx.claims.expireStale(now);

  const baseline = await ctx.gap.getBaseline();
  if (!baseline) throw new ClaimError('无对账基线：先推进契约基线再认领', 409);

  const requirementKeys = normalizeKeys(input.requirement_keys);
  const known = new Set(baseline.bom.requirements.map(requirement => requirement.key));
  const unknown = requirementKeys.filter(key => !known.has(key));
  if (unknown.length > 0) {
    throw new ClaimError(`需求键不在当前基线：${unknown.join(', ')}`, 400);
  }

  validateBoundary(input.domain, input.boundary);

  const claim: ResponsibilityClaimRecord = {
    id: ulid(),
    executor: input.executor,
    requirement_keys: requirementKeys,
    domain: input.domain,
    baseline_commit: baseline.bom_commit,
    boundary: input.boundary,
    pre_authorization: input.pre_authorization ?? null,
    isolation_mode: input.isolation_mode,
    isolation_id: input.isolation_id,
    session_ref: input.session_ref ?? null,
    status: 'active',
    lease_expires_at: new Date(Date.now() + leaseSeconds() * 1000).toISOString(),
    heartbeat_at: now,
    created_at: now,
    released_at: null,
    revoked_reason: null,
  };

  try {
    await ctx.withTx(async tx => {
      await tx.claims.insertClaim(claim);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ClaimError('需求键已被活跃认领占用（先到先得）', 409);
    }
    throw error;
  }
  return claim;
}

export async function listClaims(
  ctx: OperationContext,
  status: ClaimStatus = 'active',
): Promise<ResponsibilityClaimRecord[]> {
  await ctx.claims.expireStale(new Date().toISOString());
  return ctx.claims.listClaims(status);
}

export async function getClaim(ctx: OperationContext, id: string): Promise<ResponsibilityClaimRecord> {
  await ctx.claims.expireStale(new Date().toISOString());
  const claim = await ctx.claims.getClaim(id);
  if (!claim) throw new ClaimError('认领不存在', 404);
  return claim;
}

// @sibom r-ar2b — 租约到期/心跳中断后失效回收，失效认领保留痕迹
export async function renewClaim(
  ctx: OperationContext,
  id: string,
  input: ClaimRenewInput,
): Promise<ResponsibilityClaimRecord> {
  const now = new Date().toISOString();
  await ctx.claims.expireStale(now);
  const claim = await ctx.claims.getActiveClaim(id);
  if (!claim || claim.executor !== input.executor) {
    throw new ClaimError('无有效认领或执行者不匹配', 409);
  }
  const leaseExpiresAt = new Date(Date.now() + leaseSeconds() * 1000).toISOString();
  await ctx.claims.updateLease(id, leaseExpiresAt, now);
  return { ...claim, lease_expires_at: leaseExpiresAt, heartbeat_at: now };
}

export async function releaseClaim(
  ctx: OperationContext,
  id: string,
  input: ClaimReleaseInput,
): Promise<ResponsibilityClaimRecord> {
  const now = new Date().toISOString();
  await ctx.claims.expireStale(now);
  const claim = await ctx.claims.getActiveClaim(id);
  if (!claim || claim.executor !== input.executor) {
    throw new ClaimError('无有效认领或执行者不匹配', 409);
  }
  await ctx.claims.closeClaim(id, 'released', now);
  return { ...claim, status: 'released', released_at: now };
}

// @sibom r-ax5e — 停止以租约撤销表达，是状态变更而非进程中断
export async function revokeClaim(
  ctx: OperationContext,
  id: string,
  input: ClaimRevokeInput,
): Promise<ResponsibilityClaimRecord> {
  const now = new Date().toISOString();
  await ctx.claims.expireStale(now);
  const claim = await ctx.claims.getActiveClaim(id);
  if (!claim) throw new ClaimError('无有效认领', 409);
  const reason = `${input.revoked_by}: ${input.reason}`;
  await ctx.claims.closeClaim(id, 'revoked', now, reason);
  return { ...claim, status: 'revoked', released_at: now, revoked_reason: reason };
}

// @sibom r-bc4d — 越界即失败：越界差异记为证据，该次执行不进入验收
// @sibom r-ar6f — 完成只认证据；执行日志与自评不作为判定依据
// @sibom r-ea4d — 证据携带产生它的认领与执行者归因
export async function reportClaim(
  ctx: OperationContext,
  id: string,
  input: ClaimReportInput,
): Promise<ClaimReportResult> {
  const now = new Date().toISOString();
  await ctx.claims.expireStale(now);
  const claim = await ctx.claims.getActiveClaim(id);
  if (!claim || claim.executor !== input.executor) {
    throw new ClaimError('无有效认领或执行者不匹配', 409);
  }

  const outOfScope: string[] = [];
  const proposalOnly: string[] = [];
  for (const fact of input.changed_facts) {
    if (claim.boundary.read_only.some(scope => scopeContains(scope, fact.path))) {
      outOfScope.push(fact.path);
      continue;
    }
    const matched = matchFact(claim, fact.type, fact.path);
    if (matched === null) {
      outOfScope.push(fact.path);
      continue;
    }
    if (PROPOSAL_ONLY_FACT_TYPES.includes(matched)) proposalOnly.push(fact.path);
  }

  const evidenceSource = `claim:${id}`;
  const payload = {
    claim_id: id,
    executor: claim.executor,
    requirement_keys: claim.requirement_keys,
    session_ref: claim.session_ref,
    baseline_commit: claim.baseline_commit,
    changed_facts: input.changed_facts,
    out_of_scope: outOfScope,
    proposal_only: proposalOnly,
    incomplete_reason: input.incomplete_reason ?? null,
    result: outOfScope.length > 0 ? 'failed' : 'passed',
  };
  await ctx.gap.upsertEvidence({
    source_id: evidenceSource,
    payload,
    fingerprint: fingerprint(payload),
    reported_at: now,
    baseline_commit: claim.baseline_commit,
  });

  if (outOfScope.length > 0) {
    await ctx.claims.closeClaim(id, 'failed', now);
    return { ok: false, out_of_scope: outOfScope, proposal_only: proposalOnly, changed_facts: input.changed_facts, evidence_source: evidenceSource };
  }
  return { ok: true, out_of_scope: [], proposal_only: proposalOnly, changed_facts: input.changed_facts, evidence_source: evidenceSource };
}

// @sibom r-bc5e — 事实边界只能收窄，收窄由认领者提交；放宽须人确认
export async function narrowClaimBoundary(
  ctx: OperationContext,
  id: string,
  input: ClaimNarrowInput,
): Promise<ResponsibilityClaimRecord> {
  const now = new Date().toISOString();
  await ctx.claims.expireStale(now);
  const claim = await ctx.claims.getActiveClaim(id);
  if (!claim || claim.executor !== input.executor) {
    throw new ClaimError('无有效认领或执行者不匹配', 409);
  }
  validateBoundary(claim.domain, input.boundary);

  const widened = input.boundary.fact_types
    .flatMap(fact => fact.scopes
      .filter(scope => !claim.boundary.fact_types
        .some(outer => outer.type === fact.type && outer.scopes.some(current => scopeContains(current, scope))))
      .map(scope => `${fact.type}:${scope}`));
  if (widened.length > 0) {
    throw new ClaimError(`边界只能收窄；以下范围超出当前边界（放宽须人确认）：${widened.join(', ')}`, 409);
  }

  await ctx.claims.updateBoundary(id, input.boundary);
  return { ...claim, boundary: input.boundary, heartbeat_at: claim.heartbeat_at };
}

// @sibom r-bc2b — 契约子树写入仅限提案：认领提供提案通道，不直接改契约
// @sibom r-ar4d — 契约变更只能提案；确认由基线前移产生
export async function proposeClaimContractChange(
  ctx: OperationContext,
  id: string,
  input: ContractProposalInput,
): Promise<ProposalView> {
  const now = new Date().toISOString();
  await ctx.claims.expireStale(now);
  const claim = await ctx.claims.getActiveClaim(id);
  if (!claim || claim.executor !== input.proposer) {
    throw new ClaimError('无有效认领或提案者不匹配', 409);
  }
  const invalid = input.requirement_keys.filter(key => !claim.requirement_keys.includes(key));
  if (invalid.length > 0) {
    throw new ClaimError(`提案需求键不在认领责任范围：${invalid.join(', ')}`, 409);
  }

  const record: ProposalRecord = {
    id: ulid(),
    workpack_id: null,
    claim_id: id,
    kind: 'contract',
    proposer: input.proposer,
    requirement_keys: [...new Set(input.requirement_keys)].sort(),
    summary: input.summary,
    detail: input.detail ?? {},
    status: 'proposed',
    created_at: now,
    confirmed_commit: null,
    confirmed_by: null,
    resolved_at: null,
  };
  await ctx.proposals.insertProposal(record);
  return toProposalView(record);
}
