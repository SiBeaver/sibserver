import type { WitemStatus, DecisionStatus, RiskStatus, TechDebtStatus, KnowledgeStatus, RequirementStatus } from '../nodes/types.js';

// ============================================================
// 生命周期状态转换规则
// ============================================================

type TransitionMap<S extends string> = Partial<Record<S, S[]>>;

export const WITEM_TRANSITIONS: TransitionMap<WitemStatus> = {
  active: ['achieved', 'abandoned', 'deferred'],
  deferred: ['active', 'abandoned'],
};

export const DECISION_TRANSITIONS: TransitionMap<DecisionStatus> = {
  proposed: ['accepted', 'failed'],
  accepted: ['superseded', 'deprecated', 'failed'],
  superseded: ['failed'],
};

export const RISK_TRANSITIONS: TransitionMap<RiskStatus> = {
  identified: ['analyzing', 'accepted', 'occurred'],
  analyzing: ['mitigated', 'accepted', 'occurred'],
  mitigated: ['resolved'],
  occurred: ['resolved'],
};

export const TECH_DEBT_TRANSITIONS: TransitionMap<TechDebtStatus> = {
  identified: ['accepted'],
  accepted: ['paying_down'],
  paying_down: ['resolved'],
};

export const KNOWLEDGE_TRANSITIONS: TransitionMap<KnowledgeStatus> = {
  tentative: ['established'],
  established: ['outdated'],
};

export const REQUIREMENT_TRANSITIONS: TransitionMap<RequirementStatus> = {
  proposed: ['accepted', 'deprecated'],
  accepted: ['in_execution', 'deprecated'],
  in_execution: ['satisfied', 'revision_needed'],
  revision_needed: ['accepted', 'deprecated'],
};

// ============================================================
// 通用校验函数
// ============================================================

export function isValidTransition<S extends string>(
  transitions: TransitionMap<S>,
  from: S,
  to: S,
): boolean {
  const allowed = transitions[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
