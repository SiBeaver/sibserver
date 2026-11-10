export { OperationContext } from './context.js';
export { defineWitem, decomposeWitem, updateWitemStatus } from './witems.js';
export { recordDecision, updateDecisionStatus } from './decisions.js';
export { defineRequirement, updateRequirementStatus, updateRequirementAcceptance } from './requirements.js';
export { identifyRisk, updateRisk, registerTechDebt } from './risks.js';
export { recordKnowledge, updateKnowledge, getKnowledgeTree, pinKnowledge, moveKnowledge } from './knowledge.js';
export { linkNodes, deleteNode, getProjectState, getNodeContext } from './graph.js';
export { batchOperations, type BatchOperationsInput, type OperationHandlerMap } from './batch.js';
export {
  getRoadmap, witemProgress, decisionTrail, knowledgeTrail, knowledgeMap,
  staleItems, currentBlockers, recentActivity, fullTextSearch,
  getHelmSignals,
  KNOWLEDGE_TRAIL_RELATIONS, KNOWLEDGE_TRAIL_DEFAULT_DEPTH, KNOWLEDGE_TRAIL_MAX_DEPTH,
} from './queries.js';
export type {
  HelmSignal, HelmResponse, HelmSignalType, RoadmapItem,
  KnowledgeTrailOptions, KnowledgeTrailStep,
} from './queries.js';
