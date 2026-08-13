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
  type OperationContext,
} from '../index.js';
import type { ProjectManager } from '../projects/index.js';
import { snakeToCamel } from '../api/transforms.js';
import { evaluateAcceptanceGap, evaluateAllAcceptanceGaps } from '../policies/acceptance-evaluator.js';
import { evaluateConstraints, summarizeResults } from '../policies/constraint-evaluator.js';
import { listGaps } from '../gap/engine.js';

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

  server.tool('evaluate_gap', '三方对账差距账单（违约/缺失/需求过时三型 + 在办 witem 标注 + 豁免）；未设基准时回退验收项对账', {
    requirement_id: z.string().optional().describe('需求 ID（仅未设基准的回退模式使用）'),
  }, log('evaluate_gap', async (args) => {
    const c = getCtx();
    const ledger = await listGaps(c);
    if (ledger.bom_commit !== null) return jsonResult(ledger);
    if (args.requirement_id) {
      return jsonResult(await evaluateAcceptanceGap(c, args.requirement_id));
    }
    return jsonResult({ ...ledger, acceptance_gaps: await evaluateAllAcceptanceGaps(c) });
  }));

  server.tool('evaluate_constraint', '评估约束是否满足（需要提供证据数据）', {
    constraints: z.array(z.object({
      id: z.string().describe('约束 ID'),
      title: z.string().describe('约束名称'),
      dimension: z.enum(['security', 'performance', 'compliance', 'cost', 'reliability', 'quality']),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      description: z.string(),
      condition: z.record(z.unknown()).describe('条件对象，evidence_type: metric|code_pattern|test_result|sibs_query'),
    })).describe('约束列表'),
    evidence: z.object({
      metrics: z.record(z.number()).optional().describe('指标实测值，key 为 metric 名称'),
      pattern_results: z.record(z.object({
        matched: z.number(),
        total: z.number(),
      })).optional().describe('代码模式匹配结果，key 为约束 ID'),
    }).optional().describe('证据数据'),
  }, log('evaluate_constraint', async (args) => {
    const results = await evaluateConstraints(args.constraints, args.evidence ?? {}, getCtx());
    return jsonResult({ results, summary: summarizeResults(results) });
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
    derived_from: z.array(z.string()).optional().describe('来源节点 ID'),
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

  server.tool('evaluate_gap', '三方对账差距账单（违约/缺失/需求过时三型 + 在办 witem 标注 + 豁免）；未设基准时回退验收项对账', {
    project: projectParam,
    requirement_id: z.string().optional().describe('需求 ID（仅未设基准的回退模式使用）'),
  }, log('evaluate_gap', async ({ project, ...args }) => {
    const c = await ctx(project);
    const ledger = await listGaps(c);
    if (ledger.bom_commit !== null) return jsonResult(ledger);
    if (args.requirement_id) {
      return jsonResult(await evaluateAcceptanceGap(c, args.requirement_id));
    }
    return jsonResult({ ...ledger, acceptance_gaps: await evaluateAllAcceptanceGaps(c) });
  }));

  server.tool('evaluate_constraint', '评估约束是否满足（需要提供证据数据）', {
    project: projectParam,
    constraints: z.array(z.object({
      id: z.string().describe('约束 ID'),
      title: z.string().describe('约束名称'),
      dimension: z.enum(['security', 'performance', 'compliance', 'cost', 'reliability', 'quality']),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      description: z.string(),
      condition: z.record(z.unknown()).describe('条件对象，evidence_type: metric|code_pattern|test_result|sibs_query'),
    })).describe('约束列表'),
    evidence: z.object({
      metrics: z.record(z.number()).optional().describe('指标实测值，key 为 metric 名称'),
      pattern_results: z.record(z.object({
        matched: z.number(),
        total: z.number(),
      })).optional().describe('代码模式匹配结果，key 为约束 ID'),
    }).optional().describe('证据数据'),
  }, log('evaluate_constraint', async ({ project, ...args }) => {
    const c = await ctx(project);
    const results = await evaluateConstraints(args.constraints, args.evidence ?? {}, c);
    return jsonResult({ results, summary: summarizeResults(results) });
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
