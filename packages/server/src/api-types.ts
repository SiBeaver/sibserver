// ============================================================
// CamelCase API 响应类型 — 对应内部 snake_case 类型
//
// si-beaver REST API 通过 snakeToCamel() 转换所有响应，
// 因此 API 消费者看到的是 camelCase，而非内部存储的 snake_case。
// ============================================================

import type { EventType } from '@sibeaver/core';
import type { RelationType } from '@sibeaver/core';

// ============================================================
// 通用枚举（值相同，直接用 core 的）
// ============================================================

export type { EventType, RelationType };

export type NodeType =
  | 'witem' | 'decision'
  | 'risk' | 'tech_debt' | 'artifact' | 'knowledge' | 'requirement';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export type RequirementStatus =
  | 'proposed' | 'accepted' | 'in_execution'
  | 'revision_needed' | 'satisfied' | 'deprecated';

// ============================================================
// 基础节点
// ============================================================

export interface ApiNode {
  id: string;
  type: NodeType;
  title: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  status: string;
}

export interface ApiWitemNode extends ApiNode {
  type: 'witem';
  status: 'active' | 'achieved' | 'abandoned' | 'deferred';
  horizon: 'short' | 'medium' | 'long';
  successCriteria: string[];
  priority: Priority;
}

export interface ApiAcceptanceItem {
  id: string;
  label: string;
  satisfied: boolean;
}

export interface ApiChecklistAcceptance {
  type: 'checklist';
  items: ApiAcceptanceItem[];
}

export type ApiAcceptance = ApiChecklistAcceptance | null;

export interface ApiRequirementNode extends ApiNode {
  type: 'requirement';
  status: RequirementStatus;
  priority: Priority;
  source: string;
  sourceDetail: string | null;
  acceptance: ApiAcceptance;
}

export interface ApiKnowledgeNode extends ApiNode {
  type: 'knowledge';
  status: 'tentative' | 'established' | 'outdated';
  domain: string;
  confidence: 'low' | 'medium' | 'high';
  source: string;
  scope: 'project' | 'domain';
}

export type ApiCognitiveNode =
  | ApiWitemNode
  | ApiRequirementNode
  | ApiKnowledgeNode
  | ApiNode;

// ============================================================
// 边
// ============================================================

export interface ApiFieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ApiEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: RelationType;
  annotation?: string | null;
}

// ============================================================
// 事件
// ============================================================

export interface ApiEvent {
  id: string;
  timestamp: string;
  eventType: EventType;
  actor: 'user' | 'system';
  operation: string;
  nodeId: string | null;
  nodeType: string | null;
  payload: Record<string, unknown>;
  diff: ApiFieldDiff[] | null;
  context: string | null;
}

// ============================================================
// 复合响应
// ============================================================

export interface ApiNodeContext {
  node: ApiCognitiveNode | null;
  edges: ApiEdge[];
}

export interface ApiProjectState {
  witems: ApiNode[];
  requirements: ApiRequirementNode[];
  decisions: ApiNode[];
  risks: ApiNode[];
  techDebts: ApiNode[];
  knowledge: ApiKnowledgeNode[];
}
