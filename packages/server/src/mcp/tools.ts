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
  defineGoal, decomposeGoal, updateGoalStatus,
  createTask, updateTaskStatus,
  beginExploration, recordExplorationFinding, concludeExploration, abandonExploration,
  recordDecision,
  defineRequirement, updateRequirementStatus, updateRequirementAcceptance,
  identifyRisk, updateRisk, registerTechDebt,
  recordKnowledge,
  linkNodes, deleteNode, getProjectState, getNodeContext,
  getRoadmap, goalProgress, decisionTrail, knowledgeMap,
  staleItems, currentBlockers, recentActivity, fullTextSearch,
  batchOperations,
  generateProjection, listProjectionTypes,
  distillConversation,
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
  'define_goal', 'decompose_goal', 'update_goal_status',
  'create_task', 'update_task_status',
  'begin_exploration', 'record_exploration_finding', 'conclude_exploration', 'abandon_exploration',
  'record_decision',
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
  for (const key of ['description', 'hypothesis', 'approach'] as const) {
    const value = node[key];
    if (typeof value === 'string') {
      out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
  }
  if (Array.isArray(node.findings) && node.findings.length > 0) {
    out.findings = node.findings.slice(0, 3).map(f =>
      typeof f === 'string' && f.length > 200 ? `${f.slice(0, 200)}…` : f);
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
    delete out.requirements;
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
  /** Access project metadata for projections */
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
  define_goal: defineGoal,
  decompose_goal: decomposeGoal,
  update_goal_status: updateGoalStatus,
  create_task: createTask,
  update_task_status: updateTaskStatus,
  begin_exploration: beginExploration,
  record_exploration_finding: recordExplorationFinding,
  conclude_exploration: concludeExploration,
  abandon_exploration: abandonExploration,
  record_decision: recordDecision,
  define_requirement: defineRequirement,
  update_requirement_status: updateRequirementStatus,
  identify_risk: identifyRisk,
  update_risk: updateRisk,
  register_tech_debt: registerTechDebt,
  record_knowledge: recordKnowledge,
  link_nodes: linkNodes,
  delete_node: deleteNode,
  generate_projection: generateProjection,
  list_projections: listProjectionTypes,
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
  server.tool('define_goal', '定义一个项目目标', {
    title: z.string().describe('目标标题'),
    description: z.string().optional().describe('详细描述'),
    horizon: z.enum(['short', 'medium', 'long']).describe('时间范围'),
    success_criteria: z.array(z.string()).optional().describe('成功标准'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).describe('优先级'),
    parent_goal: z.string().optional().describe('父目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('define_goal', async (args) => {
    return jsonResult(await defineGoal(getCtx(), args));
  }));

  server.tool('decompose_goal', '将目标分解为子目标和需要的探索', {
    goal_id: z.string().describe('要分解的目标 ID'),
    sub_goals: z.array(z.object({
      title: z.string(), description: z.string().optional(),
      horizon: z.enum(['short', 'medium', 'long']),
      success_criteria: z.array(z.string()).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    })).optional().describe('子目标列表'),
    explorations_needed: z.array(z.object({
      topic: z.string(), reason: z.string(), hypothesis: z.string().optional(),
    })).optional().describe('需要的探索'),
  }, log('decompose_goal', async (args) => {
    return jsonResult(await decomposeGoal(getCtx(), args));
  }));

  server.tool('update_goal_status', '更新目标状态', {
    goal_id: z.string().describe('目标 ID'),
    new_status: z.enum(['active', 'achieved', 'abandoned', 'deferred']).describe('新状态'),
    reason: z.string().describe('变更原因'),
  }, log('update_goal_status', async (args) => {
    return jsonResult(await updateGoalStatus(getCtx(), args));
  }));

  // --- 任务 ---
  server.tool('create_task', '创建一个任务（粒度：一个可交付的工作单元，如 feature/bugfix/spike，不是执行步骤）', {
    title: z.string().describe('任务标题'),
    description: z.string().optional().describe('详细描述'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('优先级'),
    parent_goal: z.string().optional().describe('所属目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('create_task', async (args) => {
    return jsonResult(await createTask(getCtx(), args));
  }));

  server.tool('update_task_status', '更新任务状态', {
    task_id: z.string().describe('任务 ID'),
    new_status: z.enum(['open', 'in_progress', 'done', 'cancelled']).describe('新状态'),
    reason: z.string().optional().describe('变更原因'),
  }, log('update_task_status', async (args) => {
    return jsonResult(await updateTaskStatus(getCtx(), args));
  }));

  // --- 探索 ---
  server.tool('begin_exploration', '开始一个探索性调查', {
    topic: z.string().describe('探索主题'),
    hypothesis: z.string().optional().describe('假设'),
    reason: z.string().describe('为什么要探索'),
    approach: z.string().optional().describe('探索方法'),
    related_goals: z.array(z.string()).optional().describe('关联目标 ID'),
    triggered_by: z.string().optional().describe('触发此探索的节点 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('begin_exploration', async (args) => {
    return jsonResult(await beginExploration(getCtx(), args));
  }));

  server.tool('record_exploration_finding', '记录探索过程中的发现', {
    exploration_id: z.string().describe('探索 ID'),
    finding: z.string().describe('发现内容'),
    significance: z.enum(['minor', 'major', 'breakthrough']).describe('重要程度'),
    related_nodes: z.array(z.string()).optional().describe('关联节点 ID'),
  }, log('record_exploration_finding', async (args) => {
    return jsonResult(await recordExplorationFinding(getCtx(), args));
  }));

  server.tool('conclude_exploration', '结论化探索，产出决策/知识', {
    exploration_id: z.string().describe('探索 ID'),
    conclusion: z.string().describe('结论'),
    outcome: z.enum(['validated', 'invalidated', 'partial', 'inconclusive']).describe('结果类型'),
    decisions: z.array(z.object({
      title: z.string(), context: z.string().optional(),
      rationale: z.string(), consequences: z.array(z.string()).optional(),
    })).optional().describe('产出的决策'),
    knowledge: z.array(z.object({
      title: z.string(), domain: z.string(),
      description: z.string(), confidence: z.enum(['low', 'medium', 'high']).optional(),
    })).optional().describe('产出的知识'),
  }, log('conclude_exploration', async (args) => {
    return jsonResult(await concludeExploration(getCtx(), args));
  }));

  server.tool('abandon_exploration', '放弃探索', {
    exploration_id: z.string().describe('探索 ID'),
    reason: z.string().describe('放弃原因'),
    learnings: z.string().optional().describe('尽管失败但学到的东西'),
  }, log('abandon_exploration', async (args) => {
    return jsonResult(await abandonExploration(getCtx(), args));
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
    related_goals: z.array(z.string()).optional().describe('关联目标'),
    related_explorations: z.array(z.string()).optional().describe('关联探索'),
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

  // --- 需求 ---
  server.tool('define_requirement', '定义一个需求', {
    title: z.string().describe('需求标题'),
    description: z.string().optional().describe('详细描述'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('优先级'),
    source: z.string().describe('来源（oral / specs-md / docs-md / issue / meeting）'),
    source_detail: z.string().optional().describe('来源详情'),
    parent_goal: z.string().optional().describe('关联目标 ID'),
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

  server.tool('evaluate_gap', '三方对账差距账单（violation/absence/staleness 三型 + goal 标注 + 豁免）；未设基准时回退验收项对账', {
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

  server.tool('evaluate_constraint', '评估约束是否满足（需要提供 evidence 数据）', {
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
    affected_goals: z.array(z.string()).optional().describe('受影响的目标 ID'),
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
      op: z.string().describe('操作名称，如 backfill_task、conclude_exploration、delete_node 等'),
      params: z.record(z.unknown()).describe('该操作的参数'),
    })).describe('要执行的操作列表，最多 50 个'),
  }, log('batch_operations', async (args) => {
    return jsonResult(await batchOperations(getCtx(), args, operationHandlers));
  }));

  // --- 蒸馏 ---
  server.tool('distill_conversation', '从对话中蒸馏 WHY 知识（决策/知识/风险），返回变更建议', {
    messages: z.array(z.object({
      role: z.string().describe('消息角色'),
      content: z.string().describe('消息内容'),
    })).optional().describe('对话消息列表'),
    text: z.string().optional().describe('原始对话文本（与 messages 二选一）'),
    focus_types: z.array(z.enum(['decision', 'knowledge', 'risk'])).optional()
      .describe('限定提取的节点类型，默认全部'),
  }, log('distill_conversation', async (args) => {
    return jsonResult(await distillConversation(getCtx(), args));
  }));

  // --- 读操作 ---
  server.tool('get_project_state', '获取项目认知状态快照', {}, log('get_project_state', async () => {
    return jsonResult(await getProjectState(getCtx()));
  }));

  server.tool('cockpit', '驾驶舱视图：目标 + 进度 + 阻塞项', {}, log('cockpit', async () => {
    const state = await getProjectState(getCtx());
    const blockers = await currentBlockers(getCtx());
    return jsonResult({ goals: state.active_goals, requirements: state.requirements, blockers: blockers.blockers });
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
    root_goal: z.string().optional().describe('根目标 ID'),
    include_completed: z.boolean().optional().describe('是否包含已完成的目标'),
    max_depth: z.number().optional().describe('最大展开深度'),
  }, log('get_roadmap', async (args) => {
    return jsonResult(await getRoadmap(getCtx(), args));
  }));

  server.tool('goal_progress', '获取活跃目标进度', {}, log('goal_progress', async () => {
    return jsonResult(await goalProgress(getCtx()));
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

  // --- 投影 --- @sibom r-t5jw
  server.tool('generate_projection', '从语义节点生成 Markdown 投影文档', {
    type: z.string().describe('投影类型，如 "adr"'),
  }, log('generate_projection', async (args) => {
    const meta = getMetadata();
    const projections = (meta?.projections ?? {}) as Record<string, any>;
    const config = projections[args.type];
    if (!config) {
      throw new Error(`No projection config found for type "${args.type}". Configure it in project metadata.`);
    }
    return jsonResult(await generateProjection(getCtx(), { type: args.type, config }));
  }));

  server.tool('list_projections', '列出可用的投影类型及当前项目配置', {}, log('list_projections', async () => {
    const types = await listProjectionTypes();
    const meta = getMetadata();
    const configured = (meta?.projections ?? {}) as Record<string, any>;
    return jsonResult({
      available_types: types,
      configured: Object.entries(configured).map(([key, cfg]) => ({
        ...cfg,
        id: key,
      })),
    });
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
  server.tool('define_goal', '定义一个项目目标', {
    project: projectParam,
    title: z.string().describe('目标标题'),
    description: z.string().optional().describe('详细描述'),
    horizon: z.enum(['short', 'medium', 'long']).describe('时间范围'),
    success_criteria: z.array(z.string()).optional().describe('成功标准'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).describe('优先级'),
    parent_goal: z.string().optional().describe('父目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('define_goal', async ({ project, ...args }) => {
    return jsonResult(await defineGoal(await ctx(project), args));
  }));

  server.tool('decompose_goal', '将目标分解为子目标和需要的探索', {
    project: projectParam,
    goal_id: z.string().describe('要分解的目标 ID'),
    sub_goals: z.array(z.object({
      title: z.string(), description: z.string().optional(),
      horizon: z.enum(['short', 'medium', 'long']),
      success_criteria: z.array(z.string()).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    })).optional().describe('子目标列表'),
    explorations_needed: z.array(z.object({
      topic: z.string(), reason: z.string(), hypothesis: z.string().optional(),
    })).optional().describe('需要的探索'),
  }, log('decompose_goal', async ({ project, ...args }) => {
    return jsonResult(await decomposeGoal(await ctx(project), args));
  }));

  server.tool('update_goal_status', '更新目标状态', {
    project: projectParam,
    goal_id: z.string().describe('目标 ID'),
    new_status: z.enum(['active', 'achieved', 'abandoned', 'deferred']).describe('新状态'),
    reason: z.string().describe('变更原因'),
  }, log('update_goal_status', async ({ project, ...args }) => {
    return jsonResult(await updateGoalStatus(await ctx(project), args));
  }));

  // --- 任务 ---
  server.tool('create_task', '创建一个任务（粒度：一个可交付的工作单元，如 feature/bugfix/spike，不是执行步骤）', {
    project: projectParam,
    title: z.string().describe('任务标题'),
    description: z.string().optional().describe('详细描述'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('优先级'),
    parent_goal: z.string().optional().describe('所属目标 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('create_task', async ({ project, ...args }) => {
    return jsonResult(await createTask(await ctx(project), args));
  }));

  server.tool('update_task_status', '更新任务状态', {
    project: projectParam,
    task_id: z.string().describe('任务 ID'),
    new_status: z.enum(['open', 'in_progress', 'done', 'cancelled']).describe('新状态'),
    reason: z.string().optional().describe('变更原因'),
  }, log('update_task_status', async ({ project, ...args }) => {
    return jsonResult(await updateTaskStatus(await ctx(project), args));
  }));

  // --- 探索 ---
  server.tool('begin_exploration', '开始一个探索性调查', {
    project: projectParam,
    topic: z.string().describe('探索主题'),
    hypothesis: z.string().optional().describe('假设'),
    reason: z.string().describe('为什么要探索'),
    approach: z.string().optional().describe('探索方法'),
    related_goals: z.array(z.string()).optional().describe('关联目标 ID'),
    triggered_by: z.string().optional().describe('触发此探索的节点 ID'),
    tags: z.array(z.string()).optional().describe('标签'),
  }, log('begin_exploration', async ({ project, ...args }) => {
    return jsonResult(await beginExploration(await ctx(project), args));
  }));

  server.tool('record_exploration_finding', '记录探索过程中的发现', {
    project: projectParam,
    exploration_id: z.string().describe('探索 ID'),
    finding: z.string().describe('发现内容'),
    significance: z.enum(['minor', 'major', 'breakthrough']).describe('重要程度'),
    related_nodes: z.array(z.string()).optional().describe('关联节点 ID'),
  }, log('record_exploration_finding', async ({ project, ...args }) => {
    return jsonResult(await recordExplorationFinding(await ctx(project), args));
  }));

  server.tool('conclude_exploration', '结论化探索', {
    project: projectParam,
    exploration_id: z.string().describe('探索 ID'),
    conclusion: z.string().describe('结论'),
    outcome: z.enum(['validated', 'invalidated', 'partial', 'inconclusive']).describe('结果类型'),
    decisions: z.array(z.object({
      title: z.string(), context: z.string().optional(),
      rationale: z.string(), consequences: z.array(z.string()).optional(),
    })).optional().describe('产出的决策'),
    knowledge: z.array(z.object({
      title: z.string(), domain: z.string(),
      description: z.string(), confidence: z.enum(['low', 'medium', 'high']).optional(),
    })).optional().describe('产出的知识'),
  }, log('conclude_exploration', async ({ project, ...args }) => {
    return jsonResult(await concludeExploration(await ctx(project), args));
  }));

  server.tool('abandon_exploration', '放弃探索', {
    project: projectParam,
    exploration_id: z.string().describe('探索 ID'),
    reason: z.string().describe('放弃原因'),
    learnings: z.string().optional().describe('学到的东西'),
  }, log('abandon_exploration', async ({ project, ...args }) => {
    return jsonResult(await abandonExploration(await ctx(project), args));
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
    related_goals: z.array(z.string()).optional(),
    related_explorations: z.array(z.string()).optional(),
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

  // --- 需求 ---
  server.tool('define_requirement', '定义一个需求', {
    project: projectParam,
    title: z.string().describe('需求标题'),
    description: z.string().optional().describe('详细描述'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('优先级'),
    source: z.string().describe('来源（oral / specs-md / docs-md / issue / meeting）'),
    source_detail: z.string().optional().describe('来源详情'),
    parent_goal: z.string().optional().describe('关联目标 ID'),
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

  server.tool('evaluate_gap', '三方对账差距账单（violation/absence/staleness 三型 + goal 标注 + 豁免）；未设基准时回退验收项对账', {
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

  server.tool('evaluate_constraint', '评估约束是否满足（需要提供 evidence 数据）', {
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
    affected_goals: z.array(z.string()).optional(),
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

  // --- 蒸馏 ---
  server.tool('distill_conversation', '从对话中蒸馏 WHY 知识（决策/知识/风险），返回变更建议', {
    project: projectParam,
    messages: z.array(z.object({
      role: z.string().describe('消息角色'),
      content: z.string().describe('消息内容'),
    })).optional().describe('对话消息列表'),
    text: z.string().optional().describe('原始对话文本（与 messages 二选一）'),
    focus_types: z.array(z.enum(['decision', 'knowledge', 'risk'])).optional()
      .describe('限定提取的节点类型，默认全部'),
  }, log('distill_conversation', async ({ project, ...args }) => {
    return jsonResult(await distillConversation(await ctx(project), args));
  }));

  // --- 读操作 ---
  server.tool('get_project_state', '获取项目认知状态快照', { project: projectParam }, log('get_project_state', async ({ project }) => {
    return jsonResult(await getProjectState(await ctx(project)));
  }));

  server.tool('cockpit', '驾驶舱视图：目标 + 进度 + 阻塞项', { project: projectParam }, log('cockpit', async ({ project }) => {
    const state = await getProjectState(await ctx(project));
    const blockers = await currentBlockers(await ctx(project));
    return jsonResult({ goals: state.active_goals, requirements: state.requirements, blockers: blockers.blockers });
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
    project: projectParam, root_goal: z.string().optional(),
    include_completed: z.boolean().optional(), max_depth: z.number().optional(),
  }, log('get_roadmap', async ({ project, ...args }) => {
    return jsonResult(await getRoadmap(await ctx(project), args));
  }));

  server.tool('goal_progress', '获取目标进度', { project: projectParam }, log('goal_progress', async ({ project }) => {
    return jsonResult(await goalProgress(await ctx(project)));
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

  // --- 投影 ---
  server.tool('generate_projection', '从语义节点生成 Markdown 投影文档', {
    project: projectParam,
    type: z.string().describe('投影类型，如 "adr"'),
  }, log('generate_projection', async ({ project, type }) => {
    const slug = project ?? await manager.getDefaultProject();
    const proj = await manager.getProject(slug);
    const projections = (proj?.metadata?.projections ?? {}) as Record<string, any>;
    const config = projections[type];
    if (!config) {
      throw new Error(`No projection config found for type "${type}". Configure it in project metadata.`);
    }
    return jsonResult(await generateProjection(await ctx(slug), { type, config }));
  }));

  server.tool('list_projections', '列出可用的投影类型及当前项目配置', {
    project: projectParam,
  }, log('list_projections', async ({ project }) => {
    const slug = project ?? await manager.getDefaultProject();
    const proj = await manager.getProject(slug);
    const types = await listProjectionTypes();
    const configured = (proj?.metadata?.projections ?? {}) as Record<string, any>;
    return jsonResult({
      available_types: types,
      configured: Object.entries(configured).map(([key, cfg]) => ({
        ...cfg,
        id: key,
      })),
    });
  }));
}
