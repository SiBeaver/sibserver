import type { ProjectMeta, CognitiveNode } from '../lib/types';
import { getToken, clearToken } from '../lib/auth';

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function handleResponse(res: Response) {
  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...authHeaders() } : authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const handled = await handleResponse(res);
  if (handled === null) return null as T;
  return handled.json() as Promise<T>;
}

async function get<T>(url: string): Promise<T> {
  return request<T>('GET', url);
}

async function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>('POST', url, body);
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  return request<T>('PATCH', url, body);
}

async function del(url: string): Promise<void> {
  await request<null>('DELETE', url);
}

// --- Project management ---

export function fetchProjects() {
  return get<ProjectMeta[]>('/api/v1/projects');
}

export function fetchProject(slug: string) {
  return get<ProjectMeta>(`/api/v1/projects/${slug}`);
}

export function createProject(input: { slug: string; name: string; description?: string }) {
  return post<ProjectMeta>('/api/v1/projects', input);
}

export function updateProject(slug: string, body: { name?: string; description?: string }) {
  return patch<ProjectMeta>(`/api/v1/projects/${slug}`, body);
}

export function deleteProject(slug: string) {
  return del(`/api/v1/projects/${slug}`);
}

// --- Project-scoped data ---

import type {
  RoadmapResponse,
  BlockersResponse,
  ProjectState,
  NodeContext,
} from '../lib/types';

export function fetchRoadmap(slug: string, includeCompleted = true, maxDepth = 5) {
  const params = new URLSearchParams({
    'include-completed': String(includeCompleted),
    'max-depth': String(maxDepth),
  });
  return get<RoadmapResponse>(`/${slug}/api/v1/roadmap?${params}`);
}

export function fetchBlockers(slug: string) {
  return get<BlockersResponse>(`/${slug}/api/v1/blockers`);
}

export function fetchProjectState(slug: string) {
  return get<ProjectState>(`/${slug}/api/v1/state`);
}

export interface KnowledgeTreeNode {
  id: string;
  title: string;
  domain: string;
  description: string;
  content: string;
  status: string;
  confidence: string;
  scope: string;
  pinned: boolean;
  sort_order: number;
  parent_id: string | null;
  children: KnowledgeTreeNode[];
  tags: string[];
  updated_at: string;
  source: string;
}

export interface KnowledgeTreeResponse {
  tree: KnowledgeTreeNode[];
  total: number;
}

export function fetchKnowledgeTree(slug: string) {
  return get<KnowledgeTreeResponse>(`/${slug}/api/v1/knowledge/tree`);
}

export function fetchNodeContext(slug: string, nodeId: string) {
  return get<NodeContext>(`/${slug}/api/v1/nodes/${nodeId}`);
}

// --- Knowledge operations ---

export interface DistillResponse {
  created: CognitiveNode[];
  summary: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface KnowledgeChatResponse {
  reply: string;
  reasoning: string | null;
  saved: CognitiveNode[];
}

export function distillKnowledge(slug: string, text: string, domain?: string, source?: string) {
  return post<DistillResponse>(`/${slug}/api/v1/knowledge/distill`, { text, domain, source });
}

export function knowledgeChat(slug: string, messages: ChatMessage[], action?: 'chat' | 'save') {
  return post<KnowledgeChatResponse>(`/${slug}/api/v1/knowledge/chat`, { messages, action });
}

export function executeOperation(slug: string, operation: string, input: Record<string, unknown>) {
  return post<unknown>(`/${slug}/api/v1/operations/${operation}`, input);
}

export function deleteNode(slug: string, nodeId: string) {
  return post<unknown>(`/${slug}/api/v1/operations/delete-node`, { node_id: nodeId });
}

// --- Helm signals ---

export type HelmSignalType = 'proposed_requirement' | 'revision_needed' | 'knowledge_conflict' | 'blocker' | 'stale' | 'goal_review';

export interface HelmSignal {
  id: string;
  type: HelmSignalType;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  summary: string;
  node: import('../lib/types').CognitiveNode;
  context: { nodes: import('../lib/types').CognitiveNode[]; edges: any[] };
  timestamp: string;
}

export interface HelmResponse {
  signals: HelmSignal[];
  counts: Record<string, number>;
}

export function fetchHelmSignals(slug: string) {
  return get<HelmResponse>(`/${slug}/api/v1/helm`);
}

// --- Dashboard view data ---

import type { EventRecord } from '../lib/types';

export interface ActivityResponse {
  events: EventRecord[];
}

export function fetchActivity(slug: string, limit = 20) {
  return get<ActivityResponse>(`/${slug}/api/v1/activity?limit=${limit}`);
}

export interface WitemProgressItem {
  witem: import('../lib/types').CognitiveNode;
  total: number;
  done: number;
  percentage: number;
}

export interface WitemProgressResponse {
  witems: WitemProgressItem[];
}

export function fetchWitemProgress(slug: string) {
  return get<WitemProgressResponse>(`/${slug}/api/v1/witems/progress`);
}

export interface StaleItemsResponse {
  staleItems: import('../lib/types').CognitiveNode[];
  cutoffDate: string;
  days: number;
}

export function fetchStaleItems(slug: string, days = 7) {
  return get<StaleItemsResponse>(`/${slug}/api/v1/stale?days=${days}`);
}

export interface KnowledgeMapResponse {
  knowledge: import('../lib/types').CognitiveNode[];
  byDomain: Record<string, import('../lib/types').CognitiveNode[]>;
}

export function fetchKnowledgeMap(slug: string, domain?: string) {
  const params = domain ? `?domain=${encodeURIComponent(domain)}` : '';
  return get<KnowledgeMapResponse>(`/${slug}/api/v1/knowledge${params}`);
}
