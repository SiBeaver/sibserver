// si-beaver server version
export const VERSION = '0.2.0';

// core types & lifecycle
export * from './nodes/types.js';
export * from './edges/types.js';
export * from './events/types.js';
export * from './events/interfaces.js';
export * from './events/emitter.js';
export * from './lifecycle/machines.js';
export * from './context.js';

// server internals
export * from './storage/index.js';
export * from './operations/index.js';
export * from './projections/index.js';
export * from './embedding/index.js';
export { ProjectManager } from './projects/manager.js';
export type { ProjectMeta, CreateProjectInput, UpdateProjectInput } from './projects/types.js';
export { createSiBeaverApp, operationHandlers, type SiBeaverApp } from './api/server.js';
export { handleMcpRequest } from './mcp/http-server.js';
export { startEmbedSync, getEmbedSyncStats } from './jobs/embed-sync.js';
export { startLinkRepair, stopLinkRepair, getLinkRepairStats } from './jobs/link-repair.js';
export { autoLink, LINK_STRATEGIES, type AutoLinkResult } from './auto-link/index.js';

// config
export { config } from './config/index.js';

// sibs client & LLM
export { sibs, setDirectSibs, type DirectSibsContext } from './sibs-client.js';
export { chatCompletion, jsonCompletion } from './llm-client.js';
export type { ChatMessage } from './llm-client.js';
export { startPoller, onEvent, setDirectEventSource, type DirectEventSource } from './event-poller.js';
export type { EventHandler } from './event-poller.js';
export type {
  ApiEvent,
  ApiNode,
  ApiNodeContext,
  ApiProjectState,
  ApiCognitiveNode,
  ApiGoalNode,
  ApiTaskNode,
  ApiRequirementNode,
  ApiKnowledgeNode,
  ApiEdge,
  ApiFieldDiff,
} from './api-types.js';
