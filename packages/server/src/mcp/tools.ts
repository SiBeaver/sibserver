/**
 * Shared MCP tool registration.
 * Registers all si-beaver tools onto a given McpServer instance.
 *
 * Two modes:
 * - "scoped": tools operate on a fixed project context (no project param exposed)
 * - "global": tools expose an optional project param (for stdio/multi-project clients)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  defineWitem, decomposeWitem, updateWitemStatus,
  recordDecision, updateDecisionStatus,
  defineRequirement, updateRequirementStatus, updateRequirementAcceptance,
  identifyRisk, updateRisk, registerTechDebt,
  recordKnowledge,
  linkNodes, deleteNode, getProjectState, getNodeContext,
  getRoadmap, witemProgress, decisionTrail, knowledgeMap,
  staleItems, currentBlockers, recentActivity, fullTextSearch,
  batchOperations,
  BomBaselineInput, ConstraintSetInput, EvidenceReportInput, WaiverInput,
  type OperationContext,
} from '../index.js';
import type { ProjectManager } from '../projects/index.js';
import { camelToSnake, snakeToCamel } from '../api/transforms.js';
import {
  buildEvidenceScene, listConstraintSets, listGaps, reconcile, registerConstraintSet, reportEvidence, setBaseline, signWaiversByCondition,
} from '../gap/engine.js';
import {
  claimWorkpack, confirmReplanProposal, listProposals, listWorkpacks,
  narrowWorkpackBoundary, proposeContractChange, proposeReplan,
  releaseWorkpack, renewWorkpack, reportWorkpack,
} from '../workpack/engine.js';
import { listExecutors, registerExecutor } from '../executor/engine.js';
import { WorkflowContract } from '@sibeaver/core';
import {
  checkWorkflowTemplateGates, getWorkflowTemplate, listWorkflowTemplates, registerWorkflowTemplate,
} from '../workflow/engine.js';
import {
  createClaim, getClaim, listClaims, narrowClaimBoundary,
  proposeClaimContractChange, releaseClaim, renewClaim, reportClaim, revokeClaim,
} from '../claims/engine.js';

/** Wrap result: apply camelCase transform + JSON serialize for MCP text output */
function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(snakeToCamel(data), null, 2) }] };
}

// ── MCP 响应瘦身 ─────────────────────────────────────────────
// 写操作只回执确认字段（id/title/status），搜索截断 description——
// 每次 MCP 调用都进 agent 上下文，全量回显是最大的 token 浪费源；
// 全量对象按需经 get_node_context 获取。
// 注：瘦身作用于 jsonResult 已 camelCase 化的 text 数据，字段匹配按别名兼容两种形态。

/** 逻辑字段 → 候选键（camelCase 优先，兼容 snake_case 直调） */
const SLIM_FIELD_ALIASES: Array<[string, string[]]> = [
  ['id', ['id']],
  ['type', ['type']],
  ['title', ['title']],
  ['name', ['name']],
  ['status', ['status']],
  ['relation', ['relation']],
  ['eventType', ['eventType', 'event_type']],
  ['sourceId', ['sourceId', 'source_id']],
  ['targetId', ['targetId', 'target_id']],
];

const SEARCH_FIELD_ALIASES: Array<[string, string[]]> = [
  ['id', ['id']],
  ['type', ['type']],
  ['title', ['title']],
  ['status', ['status']],
  ['domain', ['domain']],
  ['confidence', ['confidence']],
  ['scope', ['scope']],
  ['createdAt', ['createdAt', 'created_at']],
];

function pickFields(node: Record<string, unknown>, aliases: Array<[string, string[]]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, candidates] of aliases) {
    for (const c of candidates) {
      if (node[c] !== undefined) {
        out[key] = node[c];
        break;
      }
    }
  }
  return out;
}

/** 节点/边/事件回执投影：只保留挑选字段 */
function slimNode(node: Record<string, unknown>): Record<string, unknown> {
  return pickFields(node, SLIM_FIELD_ALIASES);
}

/** 写操作信封瘦身：{entity, edges_created, event} → 全字段投影 */
export function slimEnvelope(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) {
      out[k] = v.map(item => (item && typeof item === 'object' ? slimNode(item as Record<string, unknown>) : item));
    } else if (v && typeof v === 'object') {
      out[k] = slimNode(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 搜索结果投影：保留挑选所需字段，description 截断 */
function slimSearchNode(node: Record<string, unknown>): Record<string, unknown> {
  const out = pickFields(node, SEARCH_FIELD_ALIASES);
  const desc = node.description;
  if (typeof desc === 'string') {
    out.description = desc.length > 200 ? `${desc.slice(0, 200)}…` : desc;
  }
  return out;
}

export function slimSearchResult(result: any): any {
  if (Array.isArray(result)) return result.map(item => slimSearchNode(item as Record<string, unknown>));
  return { ...result, results: (result.results ?? []).map((item: unknown) => slimSearchNode(item as Record<string, unknown>)) };
}

/** 批量操作：每条结果的 result 信封瘦身，summary 保留 */
export function slimBatchResult(result: any): any {
  return {
    ...result,
    results: (result.results ?? []).map((item: any) => (
      item && typeof item === 'object' && item.result && typeof item.result === 'object'
        ? { ...item, result: slimEnvelope(item.result) }
        : item
    )),
  };
}

/**
 * 工具响应瘦身（作用于 jsonResult 信封内的 text JSON）：
 * 写操作 → slimEnvelope / slimBatchResult；搜索 → slimSearchResult。
 */
function slimToolResult(toolName: string, result: any): any {
  const content = Array.isArray(result?.content) ? result.content[0] : undefined;
  if (!content || typeof content.text !== 'string') return result;
  try {
    const data = JSON.parse(content.text);
    const slimmed = toolName === 'batch_operations' ? slimBatchResult(data) : slimEnvelope(data);
    content.text = JSON.stringify(snakeToCamel(slimmed), null, 2);
  } catch {
    // 非 JSON 文本——保持原样
  }
  return result;
}

function slimSearchToolResult(result: any): any {
  const content = Array.isArray(result?.content) ? result.content[0] : undefined;
  if (!content || typeof content.text !== 'string') return result;
  try {
    const data = JSON.parse(content.text);
    content.text = JSON.stringify(snakeToCamel(slimSearchResult(data)), null, 2);
  } catch {
    // 非 JSON 文本——保持原样
  }
  return result;
}

const SLIM_WRITE_TOOLS = new Set([
  'define_witem', 'decompose_witem', 'update_witem_status',
  'record_decision', 'update_decision_status',
  'define_requirement', 'update_requirement_status', 'update_requirement_acceptance',
  'identify_risk', 'update_risk', 'register_tech_debt',
  'record_knowledge',
  'link_nodes', 'delete_node', 'batch_operations',
  'create_project', 'set_default_project',
]);

const SLIM_SEARCH_TOOLS = new Set(['search_nodes', 'full_text_search']);
const SLIM_STATE_TOOLS = new Set(['get_project_state', 'cockpit']);

/** 状态快照节点投影：保留概览字段，description 截断，去掉 content 全文，findings 只留前 3 条 */
function slimStateNode(node: Record<string, unknown>): Record<string, unknown> {
  const out = pickFields(node, [
    ['id', ['id']],
    ['type', ['type']],
    ['title', ['title']],
    ['status', ['status']],
    ['priority', ['priority']],
    ['severity', ['severity']],
    ['likelihood', ['likelihood']],
    ['impact', ['impact']],
    ['horizon', ['horizon']],
    ['confidence', ['confidence']],
    ['domain', ['domain']],
    ['scope', ['scope']],
    ['parentId', ['parentId', 'parent_id']],
    ['createdAt', ['createdAt', 'created_at']],
    ['updatedAt', ['updatedAt', 'updated_at']],
  ]);
  for (const key of ['description'] as const) {
    const value = node[key];
    if (typeof value === 'string') {
      out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
  }
  return out;
}

/** 项目状态快照瘦身：各列表按 slimStateNode 投影；requirements 与 open_requirements 重复，只留后者 + statistics */
export function slimProjectStateResult(result: any): any {
  const content = Array.isArray(result?.content) ? result.content[0] : undefined;
  if (!content || typeof content.text !== 'string') return result;
  try {
    const data = JSON.parse(content.text);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) {
        out[k] = v.map(item => (item && typeof item === 'object' ? slimStateNode(item as Record<string, unknown>) : item));
      } else {
        out[k] = v;
      }
    }
    // cockpit 等响应只有 requirements 没有 open_requirements，不能删
    if ('open_requirements' in out) {
      delete out.requirements;
    }
    content.text = JSON.stringify(snakeToCamel(out), null, 2);
  } catch {
    // 非 JSON 文本——保持原样
  }
  return result;
}

/** Wrap a tool handler with timing + error logging */
function logged<A extends Record<string, unknown>>(
  label: string,
  toolName: string,
  handler: (args: A) => Promise<any>,
): (args: A) => Promise<any> {
  return async (args: A) => {
    const start = Date.now();
    try {
      let result = await handler(args);
      if (SLIM_WRITE_TOOLS.has(toolName)) {
        result = slimToolResult(toolName, result);
      } else if (SLIM_SEARCH_TOOLS.has(toolName)) {
        result = slimSearchToolResult(result);
      } else if (SLIM_STATE_TOOLS.has(toolName)) {
        result = slimProjectStateResult(result);
      }
      console.log(`[MCP] ${label} ${toolName} ${Date.now() - start}ms`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] ${label} ${toolName} FAIL ${Date.now() - start}ms: ${msg}`);
      throw err;
    }
  };
}

// ============================================================
// 契约层 / Evidence 层 / GAP 层工具参数（与 REST 同源 schema）
// ============================================================

const BASELINE_SHAPE = {
  commit: z.string().describe('BOM 基线 commit（vibespec@master HEAD）'),
  requirements: z.array(z.object({
    key: z.string().describe('需求键（domain/req）'),
    title: z.string().describe('需求标题'),
    rules: z.array(z.object({
      id: z.string().describe('规则 ID（r-xxxx）'),
      title: z.string().describe('规则标题'),
      digest: z.string().optional().describe('判据正文摘要（判据变化进入探测）'),
    })).optional().describe('需求下的业务规则'),
    deps: z.array(z.string()).optional().describe('需求依赖（跨域规范化键）'),
  })).optional().describe('需求分区（非 draft）；缺省沿用旧基线'),
  draft_requirements: z.array(z.object({
    key: z.string().describe('draft 需求键'),
    title: z.string().describe('draft 需求标题'),
    rules: z.array(z.object({
      id: z.string(),
      title: z.string(),
      digest: z.string().optional(),
    })).optional().describe('draft 需求规则（仅身份投影，不参与对账）'),
  })).optional().describe('draft 身份投影分区；缺省沿用旧基线'),
  constraint_set_id: z.string().optional().describe('changed-key 重算引用的约束集版本；缺省=空集'),
};

const EVIDENCE_REPORT_SHAPE = {
  items: z.array(z.object({
    source_id: z.string().describe('证据源 ID：constraint:{id} / sibom-tags'),
    payload: z.unknown().describe('证据载荷（constraint: {matched,total} 或 {value}；sibom-tags: {rules:[{id,file}]}）'),
    reported_at: z.string().optional().describe('上报时间（ISO），缺省取服务器当前时间'),
    baseline_commit: z.string().optional().describe('观测对照的基线 commit，缺省取当前基线'),
  })).describe('证据项列表'),
  constraint_set_id: z.string().optional().describe('已注册约束集版本；含 constraint:{id} 项时必填'),
};

const CONSTRAINT_SET_SHAPE = {
  id: z.string().describe('调用方提供的版本号（注册后不可变）'),
  items: z.array(z.record(z.unknown())).describe('约束项列表'),
};

const WAIVER_SHAPE = {
  fingerprint: z.string().describe('差距条件指纹（evaluate_gap 行的 conditionFingerprint）'),
  reason: z.string().describe('豁免原因'),
  expires_at: z.string().nullable().optional().describe('过期时间（ISO）；null/缺省为永久'),
};

const CLAIM_FACT_TYPES = ['code', 'artifact', 'contract', 'service', 'host', 'config', 'runtime_contract'] as const;

const CLAIM_BOUNDARY_SHAPE = {
  fact_types: z.array(z.object({
    type: z.enum(CLAIM_FACT_TYPES),
    scopes: z.array(z.string().min(1)).min(1),
  })).min(1).describe('域级事实类型与可写范围'),
  read_only: z.array(z.string()).default([]),
  escalation: z.array(z.string()).default([]),
};

const CLAIM_PREAUTH_SHAPE = {
  autonomous_actions: z.array(z.string()).default([]),
  prohibited: z.array(z.string()).default([]),
  default_assumptions: z.array(z.string()).default([]),
  must_stop_conditions: z.array(z.string()).default([]),
};

const CLAIM_SESSION_SHAPE = {
  host: z.string().min(1),
  workspace: z.string().min(1),
  native_id: z.string().optional(),
};

const CLAIM_CHANGED_FACT_SHAPE = {
  type: z.enum(CLAIM_FACT_TYPES).optional(),
  path: z.string().min(1),
};

function parseBaseline(input: unknown) {
  const parsed = BomBaselineInput.safeParse(camelToSnake(input as Record<string, unknown>));
  if (!parsed.success) throw new Error(`基线参数无效：${parsed.error.message}`);
  return parsed.data;
}

function parseEvidenceReport(input: unknown) {
  const parsed = EvidenceReportInput.safeParse(camelToSnake(input as Record<string, unknown>));
  if (!parsed.success) throw new Error(`证据参数无效：${parsed.error.message}`);
  return parsed.data;
}

/** MCP 入参可能是 camelCase（规格形态），先规范化再走与 HTTP 同一份 zod 校验 */
function parseConstraintSet(input: unknown) {
  const parsed = ConstraintSetInput.safeParse(camelToSnake(input as Record<string, unknown>));
  if (!parsed.success) throw new Error(`约束集参数无效：${parsed.error.message}`);
  return parsed.data;
}

function parseWaiver(input: unknown) {
  const parsed = WaiverInput.safeParse(input);
  if (!parsed.success) throw new Error(`豁免参数无效：${parsed.error.message}`);
  return parsed.data;
}

// ============================================================
// Types
// ============================================================

export interface ScopedToolsOptions {
  mode: 'scoped';
  getContext: () => OperationContext;
  /** Expose project info tool showing current slug */
  slug: string;
  /** Access project metadata */
  getMetadata: () => Record<string, unknown>;
}

export interface GlobalToolsOptions {
  mode: 'global';
  manager: ProjectManager;
}

export type RegisterToolsOptions = ScopedToolsOptions | GlobalToolsOptions;

// ============================================================
// Registration
// ============================================================

export function registerTools(server: McpServer, opts: RegisterToolsOptions): void {
  if (opts.mode === 'global') {
    registerGlobalTools(server, opts.manager);
  } else {
    registerScopedTools(server, opts);
  }
}

// ============================================================
// Scoped mode — tools bound to a single project
// ============================================================

/** Shared operation handler map for batch_operations */
const operationHandlers: Record<string, (ctx: OperationContext, input: any) => Promise<any>> = {
  define_witem: defineWitem,
  decompose_witem: decomposeWitem,
  update_witem_status: updateWitemStatus,
  record_decision: recordDecision,
  update_decision_status: updateDecisionStatus,
  define_requirement: defineRequirement,
  update_requirement_status: updateRequirementStatus,
  identify_risk: identifyRisk,
  update_risk: updateRisk,
  register_tech_debt: registerTechDebt,
  record_knowledge: recordKnowledge,
  link_nodes: linkNodes,
  delete_node: deleteNode,
};

function registerScopedTools(server: McpServer, opts: ScopedToolsOptions): void {
  const getCtx = opts.getContext;
  const slug = opts.slug;
  const getMetadata = opts.getMetadata;
  const log = (name: string, handler: (args: any) => Promise<any>) => logged(slug, name, handler);

  // --- 项目信息 ---
  server.tool('get_project_info', '获取当前绑定的项目信息', {}, log('get_project_info', async () => {
    return jsonResult({ slug, message: `此连接绑定项目 "${slug}"` });
  }));

  // --- 目标 ---
  server.tool('define_witem', '定义一个项目目标', {
    title: z.string().describe('目标标题'),
    description: z.string().optional().describe('详细描述'),
    horizon: z.enum(['short', 'medium', 'long']).describe('时间范围'),
    success_criteria: z.array(z.string()).optional().describe('成功标准'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).describe('优先级'),
    parent_witem: z.string().optional().describe('父目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('define_witem', async (args) => {
    return jsonResult(await defineWitem(getCtx(), args));
  }));

  server.tool('decompose_witem', '将目标分解为子目标', {
    witem_id: z.string().describe('要分解的目标 ID'),
    sub_witems: z.array(z.object({
      title: z.string(), description: z.string().optional(),
      horizon: z.enum(['short', 'medium', 'long']),
      success_criteria: z.array(z.string()).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    })).optional().describe('子目标列表'),
  }, log('decompose_witem', async (args) => {
    return jsonResult(await decomposeWitem(getCtx(), args));
  }));

  server.tool('update_witem_status', '更新目标状态', {
    witem_id: z.string().describe('目标 ID'),
    new_status: z.enum(['active', 'achieved', 'abandoned', 'deferred']).describe('新状态'),
    reason: z.string().describe('变更原因'),
  }, log('update_witem_status', async (args) => {
    return jsonResult(await updateWitemStatus(getCtx(), args));
  }));

  // --- 决策 ---
  server.tool('record_decision', '记录一个架构/设计决策', {
    title: z.string().describe('决策标题'),
    context: z.string().describe('促使决策的情境'),
    rationale: z.string().describe('为什么这样决定'),
    alternatives_considered: z.array(z.object({
      option: z.string(), pros: z.array(z.string()).optional(),
      cons: z.array(z.string()).optional(), reason_rejected: z.string(),
    })).optional().describe('考虑过的备选方案'),
    consequences: z.array(z.string()).optional().describe('接受的代价'),
    related_witems: z.array(z.string()).optional().describe('关联目标'),
    supersedes: z.string().optional().describe('取代的旧决策 ID'),
    risks_created: z.array(z.object({
      title: z.string(), description: z.string(),
      likelihood: z.enum(['low', 'medium', 'high']),
      impact: z.enum(['low', 'medium', 'high', 'critical']),
    })).optional().describe('此决策引入的风险'),
    tech_debt_created: z.array(z.object({
      title: z.string(), description: z.string(),
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      affected_area: z.string(), cost_of_delay: z.string(),
    })).optional().describe('此决策引入的技术债'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('record_decision', async (args) => {
    return jsonResult(await recordDecision(getCtx(), args));
  }));

  server.tool('update_decision_status', '更新决策生命周期状态（兑现度回写：撤销/证伪置 failed）', {
    decision_id: z.string().describe('决策 ID'),
    new_status: z.enum(['accepted', 'superseded', 'deprecated', 'failed']).describe('新状态'),
    reason: z.string().describe('变更原因'),
  }, log('update_decision_status', async (args) => {
    return jsonResult(await updateDecisionStatus(getCtx(), args));
  }));

  // --- 需求 ---
  server.tool('define_requirement', '定义一个需求', {
    title: z.string().describe('需求标题'),
    description: z.string().optional().describe('详细描述'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('优先级'),
    source: z.string().describe('来源（oral / specs-md / docs-md / issue / meeting）'),
    source_detail: z.string().optional().describe('来源详情'),
    parent_witem: z.string().optional().describe('关联目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
    acceptance: z.object({
      type: z.literal('checklist'),
      items: z.array(z.object({
        id: z.string().describe('条目 ID'),
        label: z.string().describe('条目描述'),
        satisfied: z.boolean().optional().describe('是否已满足'),
      })),
    }).optional().describe('验收标准（checklist 格式）'),
    status: z.enum(['proposed', 'accepted', 'in_execution', 'revision_needed', 'satisfied', 'deprecated']).optional().describe('初始状态（默认 proposed，sync 时可指定）'),
  }, log('define_requirement', async (args) => {
    return jsonResult(await defineRequirement(getCtx(), args));
  }));

  server.tool('update_requirement_status', '更新需求状态', {
    requirement_id: z.string().describe('需求 ID'),
    new_status: z.enum(['proposed', 'accepted', 'in_execution', 'revision_needed', 'satisfied', 'deprecated']).describe('新状态'),
    reason: z.string().describe('变更原因'),
    revision_suggestion: z.string().optional().describe('修订建议（仅 revision_needed 时）'),
  }, log('update_requirement_status', async (args) => {
    return jsonResult(await updateRequirementStatus(getCtx(), args));
  }));

  server.tool('update_requirement_acceptance', '更新需求验收标准', {
    requirement_id: z.string().describe('需求 ID'),
    acceptance: z.object({
      type: z.literal('checklist'),
      items: z.array(z.object({
        id: z.string().describe('条目 ID'),
        label: z.string().describe('条目描述'),
        satisfied: z.boolean().optional().describe('是否已满足'),
      })),
    }).describe('验收标准（checklist 格式）'),
  }, log('update_requirement_acceptance', async (args) => {
    return jsonResult(await updateRequirementAcceptance(getCtx(), args));
  }));

  server.tool('evaluate_gap', '三方对账差距账单（违约/缺失/需求过时三型 + 在办 witem 标注 + 豁免）——判定仅由认知引擎统一计算', {
  }, log('evaluate_gap', async () => {
    return jsonResult(await listGaps(getCtx()));
  }));

  // --- 契约层基线 / Evidence 层 / GAP 层（差距查询之外：证据查询与检索、豁免、基线）---
  // @sibom r-mp2b — MCP 工具面覆盖契约层（需求/规则查询与编辑）、Evidence 层（查询/检索/上报）、GAP 层（差距/豁免/基线）、组织层（工作包/认领/回传）与认知层（图谱读写）

  server.tool('get_gap_baseline', '读取 GAP 基线：BOM commit + 需求/规则 + 约束快照（未设基线时返回 null）', {
  }, log('get_gap_baseline', async () => {
    const baseline = await getCtx().gap.getBaseline();
    return jsonResult(baseline ?? { bom_commit: null, bom: null, updated_at: null });
  }));

  server.tool('set_gap_baseline', '上报 BOM 快照作为 GAP 基线（requirements / draft_requirements 可分区分批上报）并重算差距', BASELINE_SHAPE, log('set_gap_baseline', async (args) => {
    return jsonResult(await setBaseline(getCtx(), parseBaseline(args)));
  }));

  server.tool('report_evidence', '上报证据项（constraint:{id} / sibom-tags）并增量重算差距', EVIDENCE_REPORT_SHAPE, log('report_evidence', async (args) => {
    return jsonResult(await reportEvidence(getCtx(), parseEvidenceReport(args)));
  }));

  server.tool('get_evidence_scene', '按需求键聚合证据对照视图（文件 @sibom 标签 / 约束运行结果 / sibs 节点）', {
    requirement_key: z.string().describe('需求键（domain/req）'),
  }, log('get_evidence_scene', async (args) => {
    return jsonResult(await buildEvidenceScene(getCtx(), args.requirement_key));
  }));

  server.tool('get_evidence_history', '按证据源 ID 追溯证据上报历史（append-only）', {
    source_id: z.string().describe('证据源 ID：constraint:{id} / sibom-tags'),
  }, log('get_evidence_history', async (args) => {
    return jsonResult(await getCtx().gap.getEvidenceHistory(args.source_id));
  }));

  server.tool('sign_gap_waiver', '按差距条件指纹签豁免（仅静默，不关闭差距；条件或证据源变化即失效）', WAIVER_SHAPE, log('sign_gap_waiver', async (args) => {
    const input = parseWaiver(args);
    const count = await signWaiversByCondition(getCtx(), input.fingerprint, input.reason, input.expires_at ?? null);
    if (count === 0) throw new Error('无匹配的 open 差距行');
    return jsonResult({ ok: true, waived: count });
  }));

  server.tool('reconcile_gap', '按基线 + 显式约束集 + 证据重算差距账本（缺省空集，不复用上次版本）', {
    constraint_set_id: z.string().optional().describe('约束集版本；缺省为空集（r-gd4d：不复用上一次的值）'),
  }, log('reconcile_gap', async ({ constraint_set_id }) => {
    return jsonResult(await reconcile(getCtx(), undefined, undefined, constraint_set_id));
  }));

  server.tool('register_constraint_set', '注册版本化约束集（不可变；同 id 异内容拒绝）', CONSTRAINT_SET_SHAPE, log('register_constraint_set', async (args) => {
    return jsonResult(await registerConstraintSet(getCtx(), parseConstraintSet(args)));
  }));

  server.tool('list_constraint_sets', '列出已注册的约束集版本（只读）', {}, log('list_constraint_sets', async () => {
    return jsonResult(await listConstraintSets(getCtx()));
  }));

  server.tool('list_workpacks', '派生工作包：按需求键聚拢开放差距，输出边界契约、依赖、并行组与验收判据（只读）', {
  }, log('list_workpacks', async () => {
    return jsonResult(await listWorkpacks(getCtx()));
  }));

  server.tool('claim_workpack', '认领工作包（租约 + 隔离声明）；同一工作包同一时刻只有一个有效认领', {
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识（harness / agent 实例）'),
    isolation_mode: z.enum(['worktree', 'workspace']).describe('worktree=独立工作区；workspace=共享工作区（串行）'),
    isolation_id: z.string().describe('隔离标识（worktree 路径 / 分支 / 工作区 ID）'),
  }, log('claim_workpack', async (args) => {
    return jsonResult(await claimWorkpack(getCtx(), args.workpack_id, {
      executor: args.executor,
      isolation_mode: args.isolation_mode,
      isolation_id: args.isolation_id,
    }));
  }));

  server.tool('renew_workpack', '续租工作包认领（心跳）', {
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
  }, log('renew_workpack', async (args) => {
    return jsonResult(await renewWorkpack(getCtx(), args.workpack_id, { executor: args.executor }));
  }));

  server.tool('release_workpack', '释放工作包认领', {
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
  }, log('release_workpack', async (args) => {
    return jsonResult(await releaseWorkpack(getCtx(), args.workpack_id, { executor: args.executor }));
  }));

  server.tool('report_workpack', '上报执行改动并做事实边界检查；越界即失败并记录证据', {
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
    changed_files: z.array(z.string()).describe('本次执行改动的文件路径'),
  }, log('report_workpack', async (args) => {
    return jsonResult(await reportWorkpack(getCtx(), args.workpack_id, {
      executor: args.executor,
      changed_files: args.changed_files,
    }));
  }));

  server.tool('narrow_workpack_boundary', '收窄认领的事实边界；放宽会被拒绝，须人确认', {
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
    writable: z.array(z.string()).describe('收窄后的可写范围（必须是当前边界的子集）'),
  }, log('narrow_workpack_boundary', async (args) => {
    return jsonResult(await narrowWorkpackBoundary(getCtx(), args.workpack_id, {
      executor: args.executor,
      writable: args.writable,
    }));
  }));

  // === 责任认领（claims）===

  server.tool('list_claims', '列出责任认领（默认活跃）；按需求键互斥并携带边界声明与租约', {
    status: z.enum(['active', 'released', 'revoked', 'expired', 'failed']).optional().describe('认领状态（缺省 active）'),
  }, log('list_claims', async (args) => {
    return jsonResult(await listClaims(getCtx(), args.status ?? 'active'));
  }));

  server.tool('get_claim', '读取单个责任认领（边界声明、预授权、会话引用与租约状态）', {
    claim_id: z.string().describe('认领 ID'),
  }, log('get_claim', async (args) => {
    return jsonResult(await getClaim(getCtx(), args.claim_id));
  }));

  server.tool('create_claim', '按责任范围建立认领：边界声明随认领提交，按需求键先到先得', {
    executor: z.string().describe('执行者标识'),
    requirement_keys: z.array(z.string()).min(1).describe('责任范围（需求键集合）'),
    domain: z.enum(['build', 'runtime']).default('build'),
    boundary: z.object(CLAIM_BOUNDARY_SHAPE),
    pre_authorization: z.object(CLAIM_PREAUTH_SHAPE).optional(),
    isolation_mode: z.enum(['worktree', 'workspace']),
    isolation_id: z.string().describe('隔离标识（worktree 路径 / 工作区 ID）'),
    session_ref: z.object(CLAIM_SESSION_SHAPE).optional(),
  }, log('create_claim', async (args) => {
    return jsonResult(await createClaim(getCtx(), {
      executor: args.executor,
      requirement_keys: args.requirement_keys,
      domain: args.domain,
      boundary: args.boundary,
      pre_authorization: args.pre_authorization,
      isolation_mode: args.isolation_mode,
      isolation_id: args.isolation_id,
      session_ref: args.session_ref,
    }));
  }));

  server.tool('renew_claim', '续租责任认领（心跳）', {
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
  }, log('renew_claim', async (args) => {
    return jsonResult(await renewClaim(getCtx(), args.claim_id, { executor: args.executor }));
  }));

  server.tool('release_claim', '释放责任认领，需求键回到可领取', {
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
    reason: z.string().optional(),
  }, log('release_claim', async (args) => {
    return jsonResult(await releaseClaim(getCtx(), args.claim_id, {
      executor: args.executor,
      reason: args.reason,
    }));
  }));

  server.tool('revoke_claim', '撤销责任认领（协作式停止，记录原因）；需求键回到可领取', {
    claim_id: z.string().describe('认领 ID'),
    revoked_by: z.string().describe('撤销发起方'),
    reason: z.string().describe('撤销原因'),
  }, log('revoke_claim', async (args) => {
    return jsonResult(await revokeClaim(getCtx(), args.claim_id, {
      revoked_by: args.revoked_by,
      reason: args.reason,
    }));
  }));

  server.tool('report_claim', '上报执行改动并做事实边界检查；越界即失败并记录证据', {
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
    changed_facts: z.array(z.object(CLAIM_CHANGED_FACT_SHAPE)).describe('本次执行改变的事实集合'),
    incomplete_reason: z.string().optional(),
  }, log('report_claim', async (args) => {
    return jsonResult(await reportClaim(getCtx(), args.claim_id, {
      executor: args.executor,
      changed_facts: args.changed_facts,
      incomplete_reason: args.incomplete_reason,
    }));
  }));

  server.tool('narrow_claim_boundary', '收窄认领的事实边界；放宽会被拒绝，须人确认', {
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
    boundary: z.object(CLAIM_BOUNDARY_SHAPE).describe('收窄后的边界声明（必须是当前边界的子集）'),
  }, log('narrow_claim_boundary', async (args) => {
    return jsonResult(await narrowClaimBoundary(getCtx(), args.claim_id, {
      executor: args.executor,
      boundary: args.boundary,
    }));
  }));

  server.tool('propose_claim_contract_change', '提交契约变更提案（契约子树写入只提案）；基线前移即人确认', {
    claim_id: z.string().describe('认领 ID'),
    proposer: z.string().describe('提案者（须为该认领执行者）'),
    summary: z.string().describe('变更摘要'),
    requirement_keys: z.array(z.string()).min(1).describe('受影响需求键（须在认领责任范围内）'),
    refs: z.array(z.object({
      path: z.string().min(1).describe('契约文件路径（BOM md / spec）'),
      commit: z.string().min(1).describe('承载变更的 git 提交'),
    })).min(1).describe('BOM/git 引用；提案正文不入控制面'),
  }, log('propose_claim_contract_change', async (args) => {
    return jsonResult(await proposeClaimContractChange(getCtx(), args.claim_id, {
      proposer: args.proposer,
      summary: args.summary,
      requirement_keys: args.requirement_keys,
      refs: args.refs,
    }));
  }));

  server.tool('propose_contract_change', '提交契约变更提案；执行者不直接修改契约，基线前移即人确认。claim_id 为主通道，workpack_id 为旧通道', {
    workpack_id: z.string().optional().describe('工作包 ID（旧通道；与 claim_id 二选一）'),
    claim_id: z.string().optional().describe('责任认领 ID（主通道；与 workpack_id 二选一）'),
    proposer: z.string().describe('提案者（claim 通道须为认领执行者）'),
    summary: z.string().describe('变更摘要'),
    requirement_keys: z.array(z.string()).min(1).describe('受影响的需求键（须在认领责任范围内）'),
    refs: z.array(z.object({
      path: z.string().min(1).describe('契约文件路径（BOM md / spec）'),
      commit: z.string().min(1).describe('承载变更的 git 提交'),
    })).min(1).describe('BOM/git 引用；提案正文不入控制面'),
  }, log('propose_contract_change', async (args) => {
    if (args.claim_id) {
      return jsonResult(await proposeClaimContractChange(getCtx(), args.claim_id, {
        proposer: args.proposer,
        summary: args.summary,
        requirement_keys: args.requirement_keys,
        refs: args.refs,
      }));
    }
    if (!args.workpack_id) throw new Error('workpack_id 与 claim_id 至少提供一个');
    return jsonResult(await proposeContractChange(getCtx(), args.workpack_id, {
      proposer: args.proposer,
      summary: args.summary,
      requirement_keys: args.requirement_keys,
      refs: args.refs,
    }));
  }));

  server.tool('propose_replan', '提交重规划提案；只提案，服务端不应用、不改已确认契约', {
    proposer: z.string().describe('规划者标识'),
    summary: z.string().describe('重规划摘要'),
    refs: z.array(z.object({
      path: z.string().min(1).describe('规划依据文件路径'),
      commit: z.string().min(1).describe('承载依据的 git 提交'),
    })).optional().describe('BOM/git 引用；提案正文不入控制面'),
  }, log('propose_replan', async (args) => {
    return jsonResult(await proposeReplan(getCtx(), { proposer: args.proposer, summary: args.summary, refs: args.refs }));
  }));

  server.tool('list_contract_proposals', '列出契约变更/重规划提案', {
    status: z.enum(['proposed', 'confirmed', 'superseded']).optional().describe('按状态过滤'),
  }, log('list_contract_proposals', async (args) => {
    return jsonResult(await listProposals(getCtx(), args.status));
  }));

  server.tool('confirm_replan_proposal', '人接受重规划提案（只记录，不改变派生工作包）', {
    proposal_id: z.string().describe('提案 ID'),
    confirmed_by: z.string().describe('确认人标识'),
  }, log('confirm_replan_proposal', async (args) => {
    return jsonResult(await confirmReplanProposal(getCtx(), args.proposal_id, {
      confirmed_by: args.confirmed_by,
    }));
  }));

  server.tool('register_executor', '注册/更新执行者画像（声明能力：harness、模型、并发度、隔离方式、可写范围）；纯记录，不路由模型', {
    executor: z.string().describe('执行者标识'),
    harness: z.string().describe('harness 名称'),
    models: z.array(z.string()).describe('可用模型（仅记录，控制面不路由）'),
    concurrency: z.number().int().min(1).describe('可并行工作包数'),
    isolation_modes: z.array(z.enum(['worktree', 'workspace'])).min(1).describe('支持的隔离方式'),
    writable_scopes: z.array(z.string()).describe('声明可写的事实范围'),
  }, log('register_executor', async (args) => {
    return jsonResult(await registerExecutor(getCtx(), args));
  }));

  server.tool('list_executors', '列出执行者画像（只读）', {
  }, log('list_executors', async () => {
    return jsonResult(await listExecutors(getCtx()));
  }));

  server.tool('register_workflow_template', '登记工作流模板引用并校验 contract 五类项；只持有引用，不执行 workflow', {
    id: z.string().describe('模板 ID'),
    harness: z.string().describe('harness 名称（如 qoder-cli）'),
    format: z.string().describe('原生格式（如 qoder-workflow / yaml）'),
    path: z.string().describe('模板路径'),
    commit: z.string().describe('模板所在提交'),
    sha256: z.string().describe('模板内容 sha256（防漂移）'),
    contract: WorkflowContract.describe('工位/检查/门禁/证据引用/执行者类型'),
  }, log('register_workflow_template', async (args) => {
    return jsonResult(await registerWorkflowTemplate(getCtx(), args));
  }));

  server.tool('list_workflow_templates', '列出工作流模板引用（只读）', {
  }, log('list_workflow_templates', async () => {
    return jsonResult(await listWorkflowTemplates(getCtx()));
  }));

  server.tool('get_workflow_template', '读取单个工作流模板引用', {
    id: z.string().describe('模板 ID'),
  }, log('get_workflow_template', async (args) => {
    const template = await getWorkflowTemplate(getCtx(), args.id);
    if (!template) throw new Error(`工作流模板不存在：${args.id}`);
    return jsonResult(template);
  }));

  server.tool('check_workflow_template_gates', '核对模板必需门禁的证据是否已上报（只核对存在）', {
    id: z.string().describe('模板 ID'),
  }, log('check_workflow_template_gates', async (args) => {
    const result = await checkWorkflowTemplateGates(getCtx(), args.id);
    if (!result) throw new Error(`工作流模板不存在：${args.id}`);
    return jsonResult(result);
  }));

  // --- 风险与技术债 ---
  server.tool('identify_risk', '识别一个项目风险', {
    title: z.string().describe('风险标题'),
    description: z.string().describe('描述'),
    likelihood: z.enum(['low', 'medium', 'high']).describe('发生概率'),
    impact: z.enum(['low', 'medium', 'high', 'critical']).describe('影响程度'),
    trigger_conditions: z.array(z.string()).optional().describe('触发条件'),
    affected_witems: z.array(z.string()).optional().describe('受影响的目标 ID'),
    mitigation_strategy: z.string().optional().describe('缓解策略'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('identify_risk', async (args) => {
    return jsonResult(await identifyRisk(getCtx(), args));
  }));

  server.tool('update_risk', '更新风险状态或评估', {
    risk_id: z.string().describe('风险 ID'),
    new_status: z.enum(['identified', 'analyzing', 'mitigated', 'accepted', 'occurred', 'resolved']).optional(),
    likelihood: z.enum(['low', 'medium', 'high']).optional(),
    impact: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    mitigation_strategy: z.string().optional(),
    reason: z.string().describe('更新原因'),
  }, log('update_risk', async (args) => {
    return jsonResult(await updateRisk(getCtx(), args));
  }));

  server.tool('register_tech_debt', '注册一项技术债', {
    title: z.string().describe('标题'),
    description: z.string().describe('描述'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).describe('严重程度'),
    affected_area: z.string().describe('受影响区域'),
    cost_of_delay: z.string().describe('不处理的代价'),
    resolution_approach: z.string().optional().describe('解决方案'),
    caused_by: z.string().optional().describe('导致此债务的决策 ID'),
    blocks: z.array(z.string()).optional().describe('被此债务阻碍的节点 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('register_tech_debt', async (args) => {
    return jsonResult(await registerTechDebt(getCtx(), args));
  }));

  // --- 知识 ---
  server.tool('record_knowledge', '记录一条项目知识', {
    title: z.string().describe('知识标题'),
    description: z.string().describe('知识内容'),
    domain: z.string().describe('所属领域'),
    confidence: z.enum(['low', 'medium', 'high']).optional().describe('确信程度'),
    source: z.string().describe('来源'),
    scope: z.enum(['project', 'domain']).optional().describe('知识范围：project=项目特定，domain=可跨项目复用的领域经验'),
    derived_from: z.array(z.string()).optional().describe('来源工作项 ID（witem），可选——知识可挂工作项留痕，也可独立沉淀'),
    invalidates: z.array(z.string()).optional().describe('被此知识取代的旧知识 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('record_knowledge', async (args) => {
    return jsonResult(await recordKnowledge(getCtx(), args));
  }));

  // --- 图操作 ---
  server.tool('link_nodes', '在两个节点之间建立语义关系', {
    source_id: z.string().describe('源节点 ID'),
    target_id: z.string().describe('目标节点 ID'),
    relation: z.enum([
      'decomposes_into', 'spawns', 'produces', 'informs', 'creates',
      'mitigates', 'addresses', 'blocks', 'relates_to', 'supersedes',
      'evidenced_by', 'derived_from', 'fulfills', 'contradicts',
    ]).describe('关系类型'),
    annotation: z.string().optional().describe('关系说明'),
  }, log('link_nodes', async (args) => {
    return jsonResult(await linkNodes(getCtx(), args));
  }));

  server.tool('delete_node', '删除节点及其所有关联边（用于清理重复或废弃节点）', {
    node_id: z.string().describe('要删除的节点 ID'),
    reason: z.string().optional().describe('删除原因'),
  }, log('delete_node', async (args) => {
    return jsonResult(await deleteNode(getCtx(), args));
  }));

  // --- 批量操作 ---
  server.tool('batch_operations', '批量执行多个操作（一次调用完成多项更新，部分失败不中断）', {
    operations: z.array(z.object({
      op: z.string().describe('操作名称，如 update_witem_status、delete_node 等'),
      params: z.record(z.unknown()).describe('该操作的参数'),
    })).describe('要执行的操作列表，最多 50 个'),
  }, log('batch_operations', async (args) => {
    return jsonResult(await batchOperations(getCtx(), args, operationHandlers));
  }));

  // --- 读操作 ---
  server.tool('get_project_state', '获取项目认知状态快照', {}, log('get_project_state', async () => {
    return jsonResult(await getProjectState(getCtx()));
  }));

  server.tool('cockpit', '驾驶舱视图：目标 + 进度 + 阻塞项', {}, log('cockpit', async () => {
    const state = await getProjectState(getCtx());
    const blockers = await currentBlockers(getCtx());
    return jsonResult({ witems: state.active_witems, requirements: state.requirements, blockers: blockers.blockers });
  }));

  server.tool('get_node_context', '获取节点完整上下文', {
    node_id: z.string().describe('节点 ID'),
    include_events: z.boolean().optional().describe('是否包含事件历史'),
  }, log('get_node_context', async (args) => {
    return jsonResult(await getNodeContext(getCtx(), args.node_id, args.include_events ?? true));
  }));

  server.tool('search_nodes', '全文搜索节点', {
    query: z.string().describe('搜索关键词'),
  }, log('search_nodes', async (args) => {
    return jsonResult(await getCtx().nodes.search(args.query));
  }));

  server.tool('get_roadmap', '获取目标路线图', {
    root_witem: z.string().optional().describe('根目标 ID'),
    include_completed: z.boolean().optional().describe('是否包含已完成的目标'),
    max_depth: z.number().optional().describe('最大展开深度'),
  }, log('get_roadmap', async (args) => {
    return jsonResult(await getRoadmap(getCtx(), args));
  }));

  server.tool('witem_progress', '获取活跃工作项进度', {}, log('witem_progress', async () => {
    return jsonResult(await witemProgress(getCtx()));
  }));

  server.tool('decision_trail', '追溯决策链', {
    node_id: z.string().describe('起始节点 ID'),
  }, log('decision_trail', async (args) => {
    return jsonResult(await decisionTrail(getCtx(), args.node_id));
  }));

  server.tool('knowledge_map', '按领域查看知识图谱', {
    domain: z.string().optional().describe('过滤领域'),
  }, log('knowledge_map', async (args) => {
    return jsonResult(await knowledgeMap(getCtx(), args.domain));
  }));

  server.tool('stale_items', '查找长时间未更新的活跃节点', {
    days: z.number().optional().describe('超过多少天视为过期，默认 7'),
  }, log('stale_items', async (args) => {
    return jsonResult(await staleItems(getCtx(), args.days));
  }));

  server.tool('current_blockers', '查找阻塞项', {}, log('current_blockers', async () => {
    return jsonResult(await currentBlockers(getCtx()));
  }));

  server.tool('recent_activity', '获取最近事件', {
    limit: z.number().optional().describe('返回事件数量，默认 20'),
  }, log('recent_activity', async (args) => {
    return jsonResult(await recentActivity(getCtx(), args.limit));
  }));

  server.tool('full_text_search', '全文搜索所有节点', {
    query: z.string().describe('搜索关键词'),
  }, log('full_text_search', async (args) => {
    return jsonResult(await fullTextSearch(getCtx(), args.query));
  }));
}

// ============================================================
// Global mode — tools with optional project param (for stdio)
// ============================================================

function registerGlobalTools(server: McpServer, manager: ProjectManager): void {
  const projectParam = z.string().optional().describe('项目 slug（默认使用当前默认项目）');
  const log = (name: string, handler: (args: any) => Promise<any>) => logged('global', name, handler);

  async function ctx(project?: string) {
    const slug = project ?? await manager.getDefaultProject();
    return manager.getContext(slug);
  }

  // --- 项目管理 ---
  server.tool('list_projects', '列出所有项目', {}, log('list_projects', async () => {
    return jsonResult(await manager.listProjects());
  }));

  server.tool('create_project', '创建一个新项目', {
    slug: z.string().describe('项目标识符'),
    name: z.string().describe('项目显示名称'),
    description: z.string().optional().describe('项目描述'),
  }, log('create_project', async (args) => {
    return jsonResult(await manager.createProject(args));
  }));

  server.tool('set_default_project', '设置默认项目', {
    slug: z.string().describe('项目 slug'),
  }, log('set_default_project', async (args) => {
    await manager.setDefaultProject(args.slug);
    return { content: [{ type: 'text', text: `Default project set to "${args.slug}"` }] };
  }));

  server.tool('get_current_project', '获取当前默认项目', {}, log('get_current_project', async () => {
    const slug = await manager.getDefaultProject();
    const project = await manager.getProject(slug);
    return jsonResult({ slug, project });
  }));

  // --- 目标 ---
  server.tool('define_witem', '定义一个项目目标', {
    project: projectParam,
    title: z.string().describe('目标标题'),
    description: z.string().optional().describe('详细描述'),
    horizon: z.enum(['short', 'medium', 'long']).describe('时间范围'),
    success_criteria: z.array(z.string()).optional().describe('成功标准'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).describe('优先级'),
    parent_witem: z.string().optional().describe('父目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('define_witem', async ({ project, ...args }) => {
    return jsonResult(await defineWitem(await ctx(project), args));
  }));

  server.tool('decompose_witem', '将目标分解为子目标', {
    project: projectParam,
    witem_id: z.string().describe('要分解的目标 ID'),
    sub_witems: z.array(z.object({
      title: z.string(), description: z.string().optional(),
      horizon: z.enum(['short', 'medium', 'long']),
      success_criteria: z.array(z.string()).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    })).optional().describe('子目标列表'),
  }, log('decompose_witem', async ({ project, ...args }) => {
    return jsonResult(await decomposeWitem(await ctx(project), args));
  }));

  server.tool('update_witem_status', '更新目标状态', {
    project: projectParam,
    witem_id: z.string().describe('目标 ID'),
    new_status: z.enum(['active', 'achieved', 'abandoned', 'deferred']).describe('新状态'),
    reason: z.string().describe('变更原因'),
  }, log('update_witem_status', async ({ project, ...args }) => {
    return jsonResult(await updateWitemStatus(await ctx(project), args));
  }));

  // --- 决策 ---
  server.tool('record_decision', '记录架构/设计决策', {
    project: projectParam,
    title: z.string().describe('决策标题'),
    context: z.string().describe('情境'),
    rationale: z.string().describe('理由'),
    alternatives_considered: z.array(z.object({
      option: z.string(), pros: z.array(z.string()).optional(),
      cons: z.array(z.string()).optional(), reason_rejected: z.string(),
    })).optional().describe('备选方案'),
    consequences: z.array(z.string()).optional().describe('代价'),
    related_witems: z.array(z.string()).optional(),
    supersedes: z.string().optional(),
    risks_created: z.array(z.object({
      title: z.string(), description: z.string(),
      likelihood: z.enum(['low', 'medium', 'high']),
      impact: z.enum(['low', 'medium', 'high', 'critical']),
    })).optional(),
    tech_debt_created: z.array(z.object({
      title: z.string(), description: z.string(),
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      affected_area: z.string(), cost_of_delay: z.string(),
    })).optional(),
    tags: z.array(z.string()).optional(),
  }, log('record_decision', async ({ project, ...args }) => {
    return jsonResult(await recordDecision(await ctx(project), args));
  }));

  server.tool('update_decision_status', '更新决策生命周期状态（兑现度回写：撤销/证伪置 failed）', {
    project: projectParam,
    decision_id: z.string().describe('决策 ID'),
    new_status: z.enum(['accepted', 'superseded', 'deprecated', 'failed']).describe('新状态'),
    reason: z.string().describe('变更原因'),
  }, log('update_decision_status', async ({ project, ...args }) => {
    return jsonResult(await updateDecisionStatus(await ctx(project), args));
  }));

  // --- 需求 ---
  server.tool('define_requirement', '定义一个需求', {
    project: projectParam,
    title: z.string().describe('需求标题'),
    description: z.string().optional().describe('详细描述'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('优先级'),
    source: z.string().describe('来源（oral / specs-md / docs-md / issue / meeting）'),
    source_detail: z.string().optional().describe('来源详情'),
    parent_witem: z.string().optional().describe('关联目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
    acceptance: z.object({
      type: z.literal('checklist'),
      items: z.array(z.object({
        id: z.string().describe('条目 ID'),
        label: z.string().describe('条目描述'),
        satisfied: z.boolean().optional().describe('是否已满足'),
      })),
    }).optional().describe('验收标准（checklist 格式）'),
    status: z.enum(['proposed', 'accepted', 'in_execution', 'revision_needed', 'satisfied', 'deprecated']).optional().describe('初始状态（默认 proposed，sync 时可指定）'),
  }, log('define_requirement', async ({ project, ...args }) => {
    return jsonResult(await defineRequirement(await ctx(project), args));
  }));

  server.tool('update_requirement_status', '更新需求状态', {
    project: projectParam,
    requirement_id: z.string().describe('需求 ID'),
    new_status: z.enum(['proposed', 'accepted', 'in_execution', 'revision_needed', 'satisfied', 'deprecated']).describe('新状态'),
    reason: z.string().describe('变更原因'),
    revision_suggestion: z.string().optional().describe('修订建议（仅 revision_needed 时）'),
  }, log('update_requirement_status', async ({ project, ...args }) => {
    return jsonResult(await updateRequirementStatus(await ctx(project), args));
  }));

  server.tool('update_requirement_acceptance', '更新需求验收标准', {
    project: projectParam,
    requirement_id: z.string().describe('需求 ID'),
    acceptance: z.object({
      type: z.literal('checklist'),
      items: z.array(z.object({
        id: z.string().describe('条目 ID'),
        label: z.string().describe('条目描述'),
        satisfied: z.boolean().optional().describe('是否已满足'),
      })),
    }).describe('验收标准（checklist 格式）'),
  }, log('update_requirement_acceptance', async ({ project, ...args }) => {
    return jsonResult(await updateRequirementAcceptance(await ctx(project), args));
  }));

  server.tool('evaluate_gap', '三方对账差距账单（违约/缺失/需求过时三型 + 在办 witem 标注 + 豁免）——判定仅由认知引擎统一计算', {
    project: projectParam,
  }, log('evaluate_gap', async ({ project }) => {
    return jsonResult(await listGaps(await ctx(project)));
  }));

  // --- 契约层基线 / Evidence 层 / GAP 层（全局模式：带可选 project 参数）---

  server.tool('get_gap_baseline', '读取 GAP 基线：BOM commit + 需求/规则 + 约束快照（未设基线时返回 null）', {
    project: projectParam,
  }, log('get_gap_baseline', async ({ project }) => {
    const baseline = await (await ctx(project)).gap.getBaseline();
    return jsonResult(baseline ?? { bom_commit: null, bom: null, updated_at: null });
  }));

  server.tool('set_gap_baseline', '上报 BOM 快照作为 GAP 基线（requirements / draft_requirements 可分区分批上报）并重算差距', {
    project: projectParam,
    ...BASELINE_SHAPE,
  }, log('set_gap_baseline', async ({ project, ...args }) => {
    return jsonResult(await setBaseline(await ctx(project), parseBaseline(args)));
  }));

  server.tool('report_evidence', '上报证据项（constraint:{id} / sibom-tags）并增量重算差距', {
    project: projectParam,
    ...EVIDENCE_REPORT_SHAPE,
  }, log('report_evidence', async ({ project, ...args }) => {
    return jsonResult(await reportEvidence(await ctx(project), parseEvidenceReport(args)));
  }));

  server.tool('get_evidence_scene', '按需求键聚合证据对照视图（文件 @sibom 标签 / 约束运行结果 / sibs 节点）', {
    project: projectParam,
    requirement_key: z.string().describe('需求键（domain/req）'),
  }, log('get_evidence_scene', async ({ project, requirement_key }) => {
    return jsonResult(await buildEvidenceScene(await ctx(project), requirement_key));
  }));

  server.tool('get_evidence_history', '按证据源 ID 追溯证据上报历史（append-only）', {
    project: projectParam,
    source_id: z.string().describe('证据源 ID：constraint:{id} / sibom-tags'),
  }, log('get_evidence_history', async ({ project, source_id }) => {
    return jsonResult(await (await ctx(project)).gap.getEvidenceHistory(source_id));
  }));

  server.tool('sign_gap_waiver', '按差距条件指纹签豁免（仅静默，不关闭差距；条件或证据源变化即失效）', {
    project: projectParam,
    ...WAIVER_SHAPE,
  }, log('sign_gap_waiver', async ({ project, ...args }) => {
    const input = parseWaiver(args);
    const count = await signWaiversByCondition(await ctx(project), input.fingerprint, input.reason, input.expires_at ?? null);
    if (count === 0) throw new Error('无匹配的 open 差距行');
    return jsonResult({ ok: true, waived: count });
  }));

  server.tool('reconcile_gap', '按基线 + 显式约束集 + 证据重算差距账本（缺省空集，不复用上次版本）', {
    project: projectParam,
    constraint_set_id: z.string().optional().describe('约束集版本；缺省为空集（r-gd4d：不复用上一次的值）'),
  }, log('reconcile_gap', async ({ project, constraint_set_id }) => {
    return jsonResult(await reconcile(await ctx(project), undefined, undefined, constraint_set_id));
  }));

  server.tool('register_constraint_set', '注册版本化约束集（不可变；同 id 异内容拒绝）', {
    project: projectParam,
    ...CONSTRAINT_SET_SHAPE,
  }, log('register_constraint_set', async ({ project, ...args }) => {
    return jsonResult(await registerConstraintSet(await ctx(project), parseConstraintSet(args)));
  }));

  server.tool('list_constraint_sets', '列出已注册的约束集版本（只读）', {
    project: projectParam,
  }, log('list_constraint_sets', async ({ project }) => {
    return jsonResult(await listConstraintSets(await ctx(project)));
  }));

  server.tool('list_workpacks', '派生工作包：按需求键聚拢开放差距，输出边界契约、依赖、并行组与验收判据（只读）', {
    project: projectParam,
  }, log('list_workpacks', async ({ project }) => {
    return jsonResult(await listWorkpacks(await ctx(project)));
  }));

  server.tool('claim_workpack', '认领工作包（租约 + 隔离声明）；同一工作包同一时刻只有一个有效认领', {
    project: projectParam,
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识（harness / agent 实例）'),
    isolation_mode: z.enum(['worktree', 'workspace']).describe('worktree=独立工作区；workspace=共享工作区（串行）'),
    isolation_id: z.string().describe('隔离标识（worktree 路径 / 分支 / 工作区 ID）'),
  }, log('claim_workpack', async ({ project, ...args }) => {
    return jsonResult(await claimWorkpack(await ctx(project), args.workpack_id, {
      executor: args.executor,
      isolation_mode: args.isolation_mode,
      isolation_id: args.isolation_id,
    }));
  }));

  server.tool('renew_workpack', '续租工作包认领（心跳）', {
    project: projectParam,
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
  }, log('renew_workpack', async ({ project, ...args }) => {
    return jsonResult(await renewWorkpack(await ctx(project), args.workpack_id, { executor: args.executor }));
  }));

  server.tool('release_workpack', '释放工作包认领', {
    project: projectParam,
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
  }, log('release_workpack', async ({ project, ...args }) => {
    return jsonResult(await releaseWorkpack(await ctx(project), args.workpack_id, { executor: args.executor }));
  }));

  server.tool('report_workpack', '上报执行改动并做事实边界检查；越界即失败并记录证据', {
    project: projectParam,
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
    changed_files: z.array(z.string()).describe('本次执行改动的文件路径'),
  }, log('report_workpack', async ({ project, ...args }) => {
    return jsonResult(await reportWorkpack(await ctx(project), args.workpack_id, {
      executor: args.executor,
      changed_files: args.changed_files,
    }));
  }));

  server.tool('narrow_workpack_boundary', '收窄认领的事实边界；放宽会被拒绝，须人确认', {
    project: projectParam,
    workpack_id: z.string().describe('工作包 ID'),
    executor: z.string().describe('执行者标识'),
    writable: z.array(z.string()).describe('收窄后的可写范围（必须是当前边界的子集）'),
  }, log('narrow_workpack_boundary', async ({ project, ...args }) => {
    return jsonResult(await narrowWorkpackBoundary(await ctx(project), args.workpack_id, {
      executor: args.executor,
      writable: args.writable,
    }));
  }));

  // === 责任认领（claims）===

  server.tool('list_claims', '列出责任认领（默认活跃）；按需求键互斥并携带边界声明与租约', {
    project: projectParam,
    status: z.enum(['active', 'released', 'revoked', 'expired', 'failed']).optional().describe('认领状态（缺省 active）'),
  }, log('list_claims', async ({ project, ...args }) => {
    return jsonResult(await listClaims(await ctx(project), args.status ?? 'active'));
  }));

  server.tool('get_claim', '读取单个责任认领（边界声明、预授权、会话引用与租约状态）', {
    project: projectParam,
    claim_id: z.string().describe('认领 ID'),
  }, log('get_claim', async ({ project, ...args }) => {
    return jsonResult(await getClaim(await ctx(project), args.claim_id));
  }));

  server.tool('create_claim', '按责任范围建立认领：边界声明随认领提交，按需求键先到先得', {
    project: projectParam,
    executor: z.string().describe('执行者标识'),
    requirement_keys: z.array(z.string()).min(1).describe('责任范围（需求键集合）'),
    domain: z.enum(['build', 'runtime']).default('build'),
    boundary: z.object(CLAIM_BOUNDARY_SHAPE),
    pre_authorization: z.object(CLAIM_PREAUTH_SHAPE).optional(),
    isolation_mode: z.enum(['worktree', 'workspace']),
    isolation_id: z.string().describe('隔离标识（worktree 路径 / 工作区 ID）'),
    session_ref: z.object(CLAIM_SESSION_SHAPE).optional(),
  }, log('create_claim', async ({ project, ...args }) => {
    return jsonResult(await createClaim(await ctx(project), {
      executor: args.executor,
      requirement_keys: args.requirement_keys,
      domain: args.domain,
      boundary: args.boundary,
      pre_authorization: args.pre_authorization,
      isolation_mode: args.isolation_mode,
      isolation_id: args.isolation_id,
      session_ref: args.session_ref,
    }));
  }));

  server.tool('renew_claim', '续租责任认领（心跳）', {
    project: projectParam,
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
  }, log('renew_claim', async ({ project, ...args }) => {
    return jsonResult(await renewClaim(await ctx(project), args.claim_id, { executor: args.executor }));
  }));

  server.tool('release_claim', '释放责任认领，需求键回到可领取', {
    project: projectParam,
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
    reason: z.string().optional(),
  }, log('release_claim', async ({ project, ...args }) => {
    return jsonResult(await releaseClaim(await ctx(project), args.claim_id, {
      executor: args.executor,
      reason: args.reason,
    }));
  }));

  server.tool('revoke_claim', '撤销责任认领（协作式停止，记录原因）；需求键回到可领取', {
    project: projectParam,
    claim_id: z.string().describe('认领 ID'),
    revoked_by: z.string().describe('撤销发起方'),
    reason: z.string().describe('撤销原因'),
  }, log('revoke_claim', async ({ project, ...args }) => {
    return jsonResult(await revokeClaim(await ctx(project), args.claim_id, {
      revoked_by: args.revoked_by,
      reason: args.reason,
    }));
  }));

  server.tool('report_claim', '上报执行改动并做事实边界检查；越界即失败并记录证据', {
    project: projectParam,
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
    changed_facts: z.array(z.object(CLAIM_CHANGED_FACT_SHAPE)).describe('本次执行改变的事实集合'),
    incomplete_reason: z.string().optional(),
  }, log('report_claim', async ({ project, ...args }) => {
    return jsonResult(await reportClaim(await ctx(project), args.claim_id, {
      executor: args.executor,
      changed_facts: args.changed_facts,
      incomplete_reason: args.incomplete_reason,
    }));
  }));

  server.tool('narrow_claim_boundary', '收窄认领的事实边界；放宽会被拒绝，须人确认', {
    project: projectParam,
    claim_id: z.string().describe('认领 ID'),
    executor: z.string().describe('执行者标识'),
    boundary: z.object(CLAIM_BOUNDARY_SHAPE).describe('收窄后的边界声明（必须是当前边界的子集）'),
  }, log('narrow_claim_boundary', async ({ project, ...args }) => {
    return jsonResult(await narrowClaimBoundary(await ctx(project), args.claim_id, {
      executor: args.executor,
      boundary: args.boundary,
    }));
  }));

  server.tool('propose_claim_contract_change', '提交契约变更提案（契约子树写入只提案）；基线前移即人确认', {
    project: projectParam,
    claim_id: z.string().describe('认领 ID'),
    proposer: z.string().describe('提案者（须为该认领执行者）'),
    summary: z.string().describe('变更摘要'),
    requirement_keys: z.array(z.string()).min(1).describe('受影响需求键（须在认领责任范围内）'),
    refs: z.array(z.object({
      path: z.string().min(1).describe('契约文件路径（BOM md / spec）'),
      commit: z.string().min(1).describe('承载变更的 git 提交'),
    })).min(1).describe('BOM/git 引用；提案正文不入控制面'),
  }, log('propose_claim_contract_change', async ({ project, ...args }) => {
    return jsonResult(await proposeClaimContractChange(await ctx(project), args.claim_id, {
      proposer: args.proposer,
      summary: args.summary,
      requirement_keys: args.requirement_keys,
      refs: args.refs,
    }));
  }));

  server.tool('propose_contract_change', '提交契约变更提案；执行者不直接修改契约，基线前移即人确认。claim_id 为主通道，workpack_id 为旧通道', {
    project: projectParam,
    workpack_id: z.string().optional().describe('工作包 ID（旧通道；与 claim_id 二选一）'),
    claim_id: z.string().optional().describe('责任认领 ID（主通道；与 workpack_id 二选一）'),
    proposer: z.string().describe('提案者（claim 通道须为认领执行者）'),
    summary: z.string().describe('变更摘要'),
    requirement_keys: z.array(z.string()).min(1).describe('受影响的需求键（须在认领责任范围内）'),
    refs: z.array(z.object({
      path: z.string().min(1).describe('契约文件路径（BOM md / spec）'),
      commit: z.string().min(1).describe('承载变更的 git 提交'),
    })).min(1).describe('BOM/git 引用；提案正文不入控制面'),
  }, log('propose_contract_change', async ({ project, ...args }) => {
    if (args.claim_id) {
      return jsonResult(await proposeClaimContractChange(await ctx(project), args.claim_id, {
        proposer: args.proposer,
        summary: args.summary,
        requirement_keys: args.requirement_keys,
        refs: args.refs,
      }));
    }
    if (!args.workpack_id) throw new Error('workpack_id 与 claim_id 至少提供一个');
    return jsonResult(await proposeContractChange(await ctx(project), args.workpack_id, {
      proposer: args.proposer,
      summary: args.summary,
      requirement_keys: args.requirement_keys,
      refs: args.refs,
    }));
  }));

  server.tool('propose_replan', '提交重规划提案；只提案，服务端不应用、不改已确认契约', {
    project: projectParam,
    proposer: z.string().describe('规划者标识'),
    summary: z.string().describe('重规划摘要'),
    refs: z.array(z.object({
      path: z.string().min(1).describe('规划依据文件路径'),
      commit: z.string().min(1).describe('承载依据的 git 提交'),
    })).optional().describe('BOM/git 引用；提案正文不入控制面'),
  }, log('propose_replan', async ({ project, ...args }) => {
    return jsonResult(await proposeReplan(await ctx(project), { proposer: args.proposer, summary: args.summary, refs: args.refs }));
  }));

  server.tool('list_contract_proposals', '列出契约变更/重规划提案', {
    project: projectParam,
    status: z.enum(['proposed', 'confirmed', 'superseded']).optional().describe('按状态过滤'),
  }, log('list_contract_proposals', async ({ project, ...args }) => {
    return jsonResult(await listProposals(await ctx(project), args.status));
  }));

  server.tool('confirm_replan_proposal', '人接受重规划提案（只记录，不改变派生工作包）', {
    project: projectParam,
    proposal_id: z.string().describe('提案 ID'),
    confirmed_by: z.string().describe('确认人标识'),
  }, log('confirm_replan_proposal', async ({ project, ...args }) => {
    return jsonResult(await confirmReplanProposal(await ctx(project), args.proposal_id, {
      confirmed_by: args.confirmed_by,
    }));
  }));

  server.tool('register_executor', '注册/更新执行者画像（声明能力：harness、模型、并发度、隔离方式、可写范围）；纯记录，不路由模型', {
    project: projectParam,
    executor: z.string().describe('执行者标识'),
    harness: z.string().describe('harness 名称'),
    models: z.array(z.string()).describe('可用模型（仅记录，控制面不路由）'),
    concurrency: z.number().int().min(1).describe('可并行工作包数'),
    isolation_modes: z.array(z.enum(['worktree', 'workspace'])).min(1).describe('支持的隔离方式'),
    writable_scopes: z.array(z.string()).describe('声明可写的事实范围'),
  }, log('register_executor', async ({ project, ...args }) => {
    return jsonResult(await registerExecutor(await ctx(project), args));
  }));

  server.tool('list_executors', '列出执行者画像（只读）', {
    project: projectParam,
  }, log('list_executors', async ({ project }) => {
    return jsonResult(await listExecutors(await ctx(project)));
  }));

  server.tool('register_workflow_template', '登记工作流模板引用并校验 contract 五类项；只持有引用，不执行 workflow', {
    project: projectParam,
    id: z.string().describe('模板 ID'),
    harness: z.string().describe('harness 名称'),
    format: z.string().describe('原生格式'),
    path: z.string().describe('模板路径'),
    commit: z.string().describe('模板所在提交'),
    sha256: z.string().describe('模板内容 sha256（防漂移）'),
    contract: WorkflowContract.describe('工位/检查/门禁/证据引用/执行者类型'),
  }, log('register_workflow_template', async ({ project, ...args }) => {
    return jsonResult(await registerWorkflowTemplate(await ctx(project), args));
  }));

  server.tool('list_workflow_templates', '列出工作流模板引用（只读）', {
    project: projectParam,
  }, log('list_workflow_templates', async ({ project }) => {
    return jsonResult(await listWorkflowTemplates(await ctx(project)));
  }));

  server.tool('get_workflow_template', '读取单个工作流模板引用', {
    project: projectParam,
    id: z.string().describe('模板 ID'),
  }, log('get_workflow_template', async ({ project, id }) => {
    const template = await getWorkflowTemplate(await ctx(project), id);
    if (!template) throw new Error(`工作流模板不存在：${id}`);
    return jsonResult(template);
  }));

  server.tool('check_workflow_template_gates', '核对模板必需门禁的证据是否已上报（只核对存在）', {
    project: projectParam,
    id: z.string().describe('模板 ID'),
  }, log('check_workflow_template_gates', async ({ project, id }) => {
    const result = await checkWorkflowTemplateGates(await ctx(project), id);
    if (!result) throw new Error(`工作流模板不存在：${id}`);
    return jsonResult(result);
  }));

  // --- 风险与技术债 ---
  server.tool('identify_risk', '识别风险', {
    project: projectParam,
    title: z.string(), description: z.string(),
    likelihood: z.enum(['low', 'medium', 'high']),
    impact: z.enum(['low', 'medium', 'high', 'critical']),
    trigger_conditions: z.array(z.string()).optional(),
    affected_witems: z.array(z.string()).optional(),
    mitigation_strategy: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }, log('identify_risk', async ({ project, ...args }) => {
    return jsonResult(await identifyRisk(await ctx(project), args));
  }));

  server.tool('update_risk', '更新风险', {
    project: projectParam,
    risk_id: z.string(), reason: z.string(),
    new_status: z.enum(['identified', 'analyzing', 'mitigated', 'accepted', 'occurred', 'resolved']).optional(),
    likelihood: z.enum(['low', 'medium', 'high']).optional(),
    impact: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    mitigation_strategy: z.string().optional(),
  }, log('update_risk', async ({ project, ...args }) => {
    return jsonResult(await updateRisk(await ctx(project), args));
  }));

  server.tool('register_tech_debt', '注册技术债', {
    project: projectParam,
    title: z.string(), description: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    affected_area: z.string(), cost_of_delay: z.string(),
    resolution_approach: z.string().optional(),
    caused_by: z.string().optional(),
    blocks: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }, log('register_tech_debt', async ({ project, ...args }) => {
    return jsonResult(await registerTechDebt(await ctx(project), args));
  }));

  // --- 知识 ---
  server.tool('record_knowledge', '记录知识', {
    project: projectParam,
    title: z.string(), description: z.string(),
    domain: z.string(), source: z.string(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
    scope: z.enum(['project', 'domain']).optional(),
    derived_from: z.array(z.string()).optional(),
    invalidates: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }, log('record_knowledge', async ({ project, ...args }) => {
    return jsonResult(await recordKnowledge(await ctx(project), args));
  }));

  // --- 图操作 ---
  server.tool('link_nodes', '建立节点间关系', {
    project: projectParam,
    source_id: z.string(), target_id: z.string(),
    relation: z.enum([
      'decomposes_into', 'spawns', 'produces', 'informs', 'creates',
      'mitigates', 'addresses', 'blocks', 'relates_to', 'supersedes',
      'evidenced_by', 'derived_from', 'fulfills', 'contradicts',
    ]),
    annotation: z.string().optional(),
  }, log('link_nodes', async ({ project, ...args }) => {
    return jsonResult(await linkNodes(await ctx(project), args));
  }));

  server.tool('delete_node', '删除节点及其所有关联边', {
    project: projectParam,
    node_id: z.string().describe('要删除的节点 ID'),
    reason: z.string().optional().describe('删除原因'),
  }, log('delete_node', async ({ project, ...args }) => {
    return jsonResult(await deleteNode(await ctx(project), args));
  }));

  // --- 批量操作 ---
  server.tool('batch_operations', '批量执行多个操作（一次调用完成多项更新）', {
    project: projectParam,
    operations: z.array(z.object({
      op: z.string().describe('操作名称'),
      params: z.record(z.unknown()).describe('该操作的参数'),
    })).describe('要执行的操作列表，最多 50 个'),
  }, log('batch_operations', async ({ project, ...args }) => {
    return jsonResult(await batchOperations(await ctx(project), args, operationHandlers));
  }));

  // --- 读操作 ---
  server.tool('get_project_state', '获取项目认知状态快照', { project: projectParam }, log('get_project_state', async ({ project }) => {
    return jsonResult(await getProjectState(await ctx(project)));
  }));

  server.tool('cockpit', '驾驶舱视图：目标 + 进度 + 阻塞项', { project: projectParam }, log('cockpit', async ({ project }) => {
    const state = await getProjectState(await ctx(project));
    const blockers = await currentBlockers(await ctx(project));
    return jsonResult({ witems: state.active_witems, requirements: state.requirements, blockers: blockers.blockers });
  }));

  server.tool('get_node_context', '获取节点完整上下文', {
    project: projectParam, node_id: z.string(),
    include_events: z.boolean().optional(),
  }, log('get_node_context', async ({ project, ...args }) => {
    return jsonResult(await getNodeContext(await ctx(project), args.node_id, args.include_events ?? true));
  }));

  server.tool('search_nodes', '全文搜索节点', { project: projectParam, query: z.string() }, log('search_nodes', async ({ project, query }) => {
    return jsonResult(await (await ctx(project)).nodes.search(query));
  }));

  server.tool('get_roadmap', '获取路线图', {
    project: projectParam, root_witem: z.string().optional(),
    include_completed: z.boolean().optional(), max_depth: z.number().optional(),
  }, log('get_roadmap', async ({ project, ...args }) => {
    return jsonResult(await getRoadmap(await ctx(project), args));
  }));

  server.tool('witem_progress', '获取活跃工作项进度', { project: projectParam }, log('witem_progress', async ({ project }) => {
    return jsonResult(await witemProgress(await ctx(project)));
  }));

  server.tool('decision_trail', '追溯决策链', { project: projectParam, node_id: z.string() }, log('decision_trail', async ({ project, node_id }) => {
    return jsonResult(await decisionTrail(await ctx(project), node_id));
  }));

  server.tool('knowledge_map', '查看知识图谱', { project: projectParam, domain: z.string().optional() }, log('knowledge_map', async ({ project, domain }) => {
    return jsonResult(await knowledgeMap(await ctx(project), domain));
  }));

  server.tool('stale_items', '查找过期节点', { project: projectParam, days: z.number().optional() }, log('stale_items', async ({ project, days }) => {
    return jsonResult(await staleItems(await ctx(project), days));
  }));

  server.tool('current_blockers', '查找阻塞项', { project: projectParam }, log('current_blockers', async ({ project }) => {
    return jsonResult(await currentBlockers(await ctx(project)));
  }));

  server.tool('recent_activity', '获取最近事件', { project: projectParam, limit: z.number().optional() }, log('recent_activity', async ({ project, limit }) => {
    return jsonResult(await recentActivity(await ctx(project), limit));
  }));

  server.tool('full_text_search', '全文搜索', { project: projectParam, query: z.string() }, log('full_text_search', async ({ project, query }) => {
    return jsonResult(await fullTextSearch(await ctx(project), query));
  }));
}
