import { config } from './config/index.js';
import type {
  ApiNodeContext,
  ApiProjectState,
  ApiEvent,
  ApiCognitiveNode,
} from './api-types.js';

// ============================================================
// Direct-mode: 统一部署时绕过 HTTP，直接调用 si-beaver handler
// ============================================================

export interface DirectSibsContext {
  getProjectState: () => Promise<ApiProjectState>;
  getNodeContext: (nodeId: string) => Promise<ApiNodeContext>;
  defineGoal: (input: any) => Promise<any>;
  updateRequirementStatus: (input: any) => Promise<any>;
  linkNodes: (input: any) => Promise<any>;
  recordKnowledge: (input: any) => Promise<any>;
  identifyRisk: (input: any) => Promise<any>;
}

let directCtx: DirectSibsContext | null = null;

export function setDirectSibs(ctx: DirectSibsContext): void {
  directCtx = ctx;
}

export function isDirectMode(): boolean {
  return directCtx !== null;
}

// ============================================================
// HTTP mode（原有逻辑）
// ============================================================

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${config.sibsUrl}${path}`;
  const headers: Record<string, string> = {};
  if (config.sibsToken) headers["Authorization"] = `Bearer ${config.sibsToken}`;
  if (opts.body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SIBS ${opts.method || "GET"} ${path} → ${res.status}：${text}`);
  }
  return res.json() as Promise<T>;
}

function projectPath(path: string): string {
  return `/${config.sibsProject}/api/v1${path}`;
}

function operation(name: string, body: unknown) {
  return request(projectPath(`/operations/${name}`), { method: "POST", body });
}

// ============================================================
// sibs 统一接口：优先 direct mode，fallback HTTP
// ============================================================

export const sibs = {
  getProjectState() {
    if (directCtx) return directCtx.getProjectState();
    return request<ApiProjectState>(projectPath("/state"));
  },

  getNodeContext(nodeId: string) {
    if (directCtx) return directCtx.getNodeContext(nodeId);
    return request<ApiNodeContext>(projectPath(`/nodes/${nodeId}`));
  },

  defineGoal(input: {
    title: string; horizon: string; priority: string;
    description?: string; parent_goal?: string;
  }) {
    if (directCtx) return directCtx.defineGoal(input);
    return operation("define-goal", input);
  },

  updateRequirementStatus(input: {
    requirementId: string; newStatus: string; reason: string;
    revisionSuggestion?: string;
  }) {
    if (directCtx) return directCtx.updateRequirementStatus(input);
    return operation("update-requirement-status", input);
  },

  linkNodes(input: {
    sourceId: string; targetId: string; relation: string; annotation?: string;
  }) {
    if (directCtx) return directCtx.linkNodes(input);
    return operation("link-nodes", input);
  },

  recordKnowledge(input: {
    title: string; description: string; domain: string;
    source: string; confidence?: string;
  }) {
    if (directCtx) return directCtx.recordKnowledge(input);
    return operation("record-knowledge", input);
  },

  identifyRisk(input: {
    title: string; description: string; likelihood: string;
    impact: string; tags?: string[];
  }) {
    if (directCtx) return directCtx.identifyRisk(input);
    return operation("identify-risk", input);
  },
};
