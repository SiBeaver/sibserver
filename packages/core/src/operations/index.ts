export { OperationContext } from './context.js';
export { defineGoal, decomposeGoal, updateGoalStatus } from './goals.js';
export { createTask, updateTaskStatus } from './tasks.js';
export { beginExploration, recordExplorationFinding, concludeExploration, abandonExploration } from './exploration.js';
export { recordDecision } from './decisions.js';
export { defineRequirement, updateRequirementStatus, updateRequirementAcceptance } from './requirements.js';
export { identifyRisk, updateRisk, registerTechDebt } from './risks.js';
export { recordKnowledge, updateKnowledge, getKnowledgeTree, pinKnowledge, moveKnowledge } from './knowledge.js';
export { linkNodes, deleteNode, getProjectState, getNodeContext } from './graph.js';
export { batchOperations, type BatchOperationsInput, type OperationHandlerMap } from './batch.js';
export {
  getRoadmap, goalProgress, decisionTrail, knowledgeMap,
  staleItems, currentBlockers, recentActivity, fullTextSearch,
  getHelmSignals,
} from './queries.js';
export type { HelmSignal, HelmResponse, HelmSignalType, RoadmapItem } from './queries.js';
