// sibeaver server version
export const VERSION = '0.2.0';

// core — graph types, storage, events, lifecycle, node operations
export * from '@sibeaver/core';

// server internals
export { ProjectManager } from './projects/manager.js';
export type { ProjectMeta, CreateProjectInput, UpdateProjectInput } from './projects/types.js';
export { createSiBeaverApp, operationHandlers, type SiBeaverApp } from './api/server.js';
export { handleMcpRequest } from './mcp/http-server.js';

// operations extensions — distill stays server-side (depends on llm-client)
export { distillConversation, type DistillConversationInput, type DistillConversationResponse, type DistillProposal } from './operations/distill-conversation.js';

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
