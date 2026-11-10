import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getRequestListener } from '@hono/node-server';
import { handleMcpRequest } from '../mcp/http-server.js';
import { chatCompletion, jsonCompletion, type ChatMessage } from '../llm-client.js';
import type { OperationContext, BatchOperationsInput } from '../index.js';
import {
  defineWitem, decomposeWitem, updateWitemStatus,
  recordDecision, updateDecisionStatus,
  defineRequirement, updateRequirementStatus, updateRequirementAcceptance,
  identifyRisk, updateRisk, registerTechDebt,
  recordKnowledge, updateKnowledge, getKnowledgeTree, pinKnowledge, moveKnowledge,
  linkNodes, deleteNode, getProjectState, getNodeContext,
  getRoadmap, witemProgress, decisionTrail, knowledgeTrail, knowledgeMap,
  KNOWLEDGE_TRAIL_RELATIONS, KNOWLEDGE_TRAIL_MAX_DEPTH,
  staleItems, currentBlockers, recentActivity, fullTextSearch,
  getHelmSignals,
  batchOperations,
} from '../index.js';
import { ProjectManager } from '../projects/index.js';
import { setDirectSibs } from '../sibs-client.js';
import type { DirectSibsContext } from '../sibs-client.js';
import { config } from '../config/index.js';
import { snakeToCamel, camelToSnake, kebabToSnake, toApiEvent } from './transforms.js';
import { setBaseline, reportEvidence, reconcile, listGaps, buildEvidenceScene, signWaiversByCondition, registerConstraintSet, listConstraintSets } from '../gap/engine.js';
import { listProposals } from '../proposals/engine.js';
import { listExecutors, registerExecutor } from '../executor/engine.js';
import {
  checkWorkflowTemplateGates, getWorkflowTemplate, listWorkflowTemplates, registerWorkflowTemplate,
} from '../workflow/engine.js';
import {
  ClaimError, createClaim, getClaim, listClaims, narrowClaimBoundary,
  proposeClaimContractChange, releaseClaim, renewClaim, reportClaim, revokeClaim,
} from '../claims/engine.js';
import {
  BomBaselineInput, ClaimCreateInput, ClaimNarrowInput, ClaimReleaseInput,
  ClaimRenewInput, ClaimReportInput, ClaimRevokeInput, ClaimStatus,
  ConstraintSetInput, ContractProposalInput,
  EvidenceReportInput, ExecutorProfileInput,
  ProposalStatus, WaiverInput, WorkflowTemplateInput,
} from '@sibeaver/core';

// ============================================================
// 操作处理器注册表（导出供 direct-mode 调用方使用）
// ============================================================

export const operationHandlers: Record<string, (ctx: OperationContext, input: any) => Promise<any>> = {
  define_witem: defineWitem,
  decompose_witem: decomposeWitem,
  update_witem_status: updateWitemStatus,
  record_decision: recordDecision,
  update_decision_status: updateDecisionStatus,
  define_requirement: defineRequirement,
  update_requirement_status: updateRequirementStatus,
  update_requirement_acceptance: updateRequirementAcceptance,
  identify_risk: identifyRisk,
  update_risk: updateRisk,
  register_tech_debt: registerTechDebt,
  record_knowledge: recordKnowledge,
  update_knowledge: updateKnowledge,
  pin_knowledge: pinKnowledge,
  move_knowledge: moveKnowledge,
  link_nodes: linkNodes,
  delete_node: deleteNode,
};

// ============================================================
// createHonoApp — 创建配置好所有路由的 Hono app
// ============================================================

export function createHonoApp(manager: ProjectManager, authToken?: string): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/api/*', cors());
  app.use('/:project/api/*', cors());

  // @sibom r-mp3c — Bearer Token 认证：REST 与 MCP 路由统一校验；未配置 AUTH_TOKEN/SI_BEAVER_AUTH_TOKEN 时开放内网访问
  if (authToken) {
    const authMw = async (c: any, next: any) => {
      const provided = c.req.header('Authorization') ?? '';
      const ok = timingSafeEqual(
        createHash('sha256').update(provided).digest(),
        createHash('sha256').update(`Bearer ${authToken}`).digest(),
      );
      if (!ok) {
        return c.json({ error: '未授权' }, 401);
      }
      await next();
    };
    app.use('/api/*', authMw);
    app.use('/:project/api/*', authMw);
  }

  const loggingMw = async (c: any, next: any) => {
    const start = Date.now();
    await next();
    console.log(`[API] ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
  };
  app.use('/api/*', loggingMw);
  app.use('/:project/api/*', loggingMw);

  function json(c: any, data: unknown, status?: number) {
    return c.json(snakeToCamel(data), status);
  }

  function getCtx(slug: string): OperationContext {
    return manager.getContext(slug);
  }

  // === 监控路由 ===

  // === 项目管理路由 ===

  app.get('/api/v1/projects', async (c) => {
    return json(c, await manager.listProjects());
  });

  app.post('/api/v1/projects', async (c) => {
    try {
      const input = await c.req.json();
      const result = await manager.createProject(input);
      return json(c, result, 201);
    } catch (e: any) {
      return json(c, { error: e.message }, 400);
    }
  });

  app.get('/api/v1/projects/:slug', async (c) => {
    const slug = c.req.param('slug');
    const project = await manager.getProject(slug);
    if (!project) return json(c, { error: '项目不存在' }, 404);
    return json(c, project);
  });

  app.patch('/api/v1/projects/:slug', async (c) => {
    const slug = c.req.param('slug');
    try {
      const patch = await c.req.json();
      const result = await manager.updateProject(slug, patch);
      return json(c, result);
    } catch (e: any) {
      return json(c, { error: e.message }, 400);
    }
  });

  app.delete('/api/v1/projects/:slug', async (c) => {
    const slug = c.req.param('slug');
    await manager.deleteProject(slug);
    return c.body(null, 204);
  });

  // === 项目级读操作 (/:project/api/v1/...) ===

  app.get('/:project/api/v1/state', async (c) => {
    const slug = c.req.param('project');
    try {
      return json(c, await getProjectState(getCtx(slug)));
    } catch (e: any) {
      return json(c, { error: e.message }, 404);
    }
  });

  app.get('/:project/api/v1/nodes', async (c) => {
    const slug = c.req.param('project');
    const type = c.req.query('type');
    if (!type) return json(c, { error: '缺少查询参数 "type"' }, 400);
    const nodes = await getCtx(slug).nodes.getByType(type as any);
    return json(c, nodes);
  });

  app.get('/:project/api/v1/nodes/:id', async (c) => {
    const slug = c.req.param('project');
    const nodeId = c.req.param('id');
    try {
      return json(c, await getNodeContext(getCtx(slug), nodeId));
    } catch (e: any) {
      return json(c, { error: e.message }, 404);
    }
  });

  app.get('/:project/api/v1/nodes/:id/history', async (c) => {
    const slug = c.req.param('project');
    const nodeId = c.req.param('id');
    const events = await getCtx(slug).eventStore.getByNode(nodeId);
    return json(c, events.map(toApiEvent));
  });

  app.get('/:project/api/v1/nodes/:id/trail', async (c) => {
    const slug = c.req.param('project');
    const nodeId = c.req.param('id');
    try {
      return json(c, await decisionTrail(getCtx(slug), nodeId));
    } catch (e: any) {
      return json(c, { error: e.message }, 404);
    }
  });

  app.get('/:project/api/v1/nodes/:id/knowledge-trail', async (c) => {
    const slug = c.req.param('project');
    const nodeId = c.req.param('id');
    const maxDepthRaw = c.req.query('max_depth');
    const maxDepth = maxDepthRaw === undefined || maxDepthRaw === ''
      ? undefined
      : Number(maxDepthRaw);
    if (
      maxDepth !== undefined &&
      (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > KNOWLEDGE_TRAIL_MAX_DEPTH)
    ) {
      return json(c, { error: `无效的 max_depth：需要 0–${KNOWLEDGE_TRAIL_MAX_DEPTH} 的整数` }, 400);
    }
    const relationsRaw = c.req.query('relations');
    const relations = relationsRaw?.split(',').map(r => r.trim()).filter(Boolean);
    const allowedRelations = new Set<string>(KNOWLEDGE_TRAIL_RELATIONS);
    if (relations?.some(r => !allowedRelations.has(r))) {
      return json(c, { error: '无效的 relations：包含未知关系类型' }, 400);
    }
    try {
      return json(c, await knowledgeTrail(getCtx(slug), nodeId, {
        max_depth: maxDepth,
        relations: relations && relations.length > 0 ? relations : undefined,
      }));
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('节点不存在')) return json(c, { error: message }, 404);
      if (
        message.startsWith('知识链起点类型不符') ||
        message.startsWith('未知知识链关系')
      ) {
        return json(c, { error: message }, 400);
      }
      return json(c, { error: '知识链遍历失败' }, 500);
    }
  });

  app.get('/:project/api/v1/search', async (c) => {
    const slug = c.req.param('project');
    const q = c.req.query('q');
    if (!q) return json(c, { error: '缺少查询参数 "q"' }, 400);
    return json(c, await getCtx(slug).nodes.search(q));
  });

  app.get('/:project/api/v1/events', async (c) => {
    const slug = c.req.param('project');
    const since = c.req.query('since');
    const limit = c.req.query('limit');
    const ctx = getCtx(slug);
    const clamped = Math.min(Math.max(Number(limit) || 20, 1), 200);
    if (since) {
      const events = await ctx.eventStore.getSince(since);
      return json(c, { events: events.map(toApiEvent) });
    }
    const events = await ctx.eventStore.getRecent(clamped);
    return json(c, { events: events.map(toApiEvent) });
  });

  app.get('/:project/api/v1/roadmap', async (c) => {
    const slug = c.req.param('project');
    const rootWitem = c.req.query('root-witem');
    const includeCompleted = c.req.query('include-completed') === 'true';
    const maxDepth = c.req.query('max-depth');
    try {
      const result = await getRoadmap(getCtx(slug), {
        root_witem: rootWitem || undefined,
        include_completed: includeCompleted,
        max_depth: maxDepth ? Number(maxDepth) : undefined,
      });
      return json(c, result);
    } catch (e: any) {
      return json(c, { error: e.message }, 404);
    }
  });

  app.get('/:project/api/v1/witems/progress', async (c) => {
    const slug = c.req.param('project');
    return json(c, await witemProgress(getCtx(slug)));
  });

  app.get('/:project/api/v1/knowledge', async (c) => {
    const slug = c.req.param('project');
    const domain = c.req.query('domain');
    return json(c, await knowledgeMap(getCtx(slug), domain || undefined));
  });

  app.get('/:project/api/v1/knowledge/tree', async (c) => {
    const slug = c.req.param('project');
    return json(c, await getKnowledgeTree(getCtx(slug)));
  });

  app.get('/:project/api/v1/cockpit', async (c) => {
    const slug = c.req.param('project');
    const state = await getProjectState(getCtx(slug));
    const blockers = await currentBlockers(getCtx(slug));
    return json(c, { witems: state.active_witems, requirements: state.requirements, blockers: blockers.blockers });
  });

  app.get('/:project/api/v1/stale', async (c) => {
    const slug = c.req.param('project');
    const days = c.req.query('days');
    return json(c, await staleItems(getCtx(slug), days ? Number(days) : undefined));
  });

  app.get('/:project/api/v1/blockers', async (c) => {
    const slug = c.req.param('project');
    return json(c, await currentBlockers(getCtx(slug)));
  });

  app.get('/:project/api/v1/gaps', async (c) => {
    const slug = c.req.param('project');
    // 判定只有一处（r-gd6f）：恒返认知引擎统一计算的账本，无回退分支
    return json(c, await listGaps(getCtx(slug)));
  });

  // === 责任认领（claims）——边界声明随认领提交，互斥按需求键 ===

  app.get('/:project/api/v1/claims', async (c) => {
    const slug = c.req.param('project');
    const status = c.req.query('status');
    const parsed = status ? ClaimStatus.safeParse(status) : null;
    if (parsed && !parsed.success) return json(c, { error: `未知认领状态：${status}` }, 400);
    return json(c, await listClaims(getCtx(slug), parsed?.success ? parsed.data : 'active'));
  });

  app.get('/:project/api/v1/claims/:id', async (c) => {
    const slug = c.req.param('project');
    try {
      return json(c, await getClaim(getCtx(slug), c.req.param('id')));
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.post('/:project/api/v1/claims', async (c) => {
    const slug = c.req.param('project');
    const parsed = ClaimCreateInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await createClaim(getCtx(slug), parsed.data), 201);
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.post('/:project/api/v1/claims/:id/renew', async (c) => {
    const slug = c.req.param('project');
    const parsed = ClaimRenewInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await renewClaim(getCtx(slug), c.req.param('id'), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.post('/:project/api/v1/claims/:id/release', async (c) => {
    const slug = c.req.param('project');
    const parsed = ClaimReleaseInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await releaseClaim(getCtx(slug), c.req.param('id'), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.post('/:project/api/v1/claims/:id/revoke', async (c) => {
    const slug = c.req.param('project');
    const parsed = ClaimRevokeInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await revokeClaim(getCtx(slug), c.req.param('id'), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.post('/:project/api/v1/claims/:id/report', async (c) => {
    const slug = c.req.param('project');
    const parsed = ClaimReportInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await reportClaim(getCtx(slug), c.req.param('id'), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.post('/:project/api/v1/claims/:id/narrow', async (c) => {
    const slug = c.req.param('project');
    const parsed = ClaimNarrowInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await narrowClaimBoundary(getCtx(slug), c.req.param('id'), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.post('/:project/api/v1/claims/:id/proposals', async (c) => {
    const slug = c.req.param('project');
    const parsed = ContractProposalInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await proposeClaimContractChange(getCtx(slug), c.req.param('id'), parsed.data), 201);
    } catch (e: any) {
      return json(c, { error: e.message }, e instanceof ClaimError ? e.status : 400);
    }
  });

  app.get('/:project/api/v1/executors', async (c) => {
    const slug = c.req.param('project');
    return json(c, await listExecutors(getCtx(slug)));
  });

  app.post('/:project/api/v1/executors', async (c) => {
    const slug = c.req.param('project');
    const parsed = ExecutorProfileInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    return json(c, await registerExecutor(getCtx(slug), parsed.data));
  });

  // 工作流模板：只登记引用 + 校验 contract 与门禁证据，不执行 workflow（r-ea2b）
  app.get('/:project/api/v1/workflow-templates', async (c) => {
    return json(c, await listWorkflowTemplates(getCtx(c.req.param('project'))));
  });

  app.post('/:project/api/v1/workflow-templates', async (c) => {
    const slug = c.req.param('project');
    const parsed = WorkflowTemplateInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await registerWorkflowTemplate(getCtx(slug), parsed.data), 201);
    } catch (e: any) {
      return json(c, { error: e.message }, 400);
    }
  });

  app.get('/:project/api/v1/workflow-templates/:id', async (c) => {
    const template = await getWorkflowTemplate(getCtx(c.req.param('project')), c.req.param('id'));
    if (!template) return json(c, { error: '工作流模板不存在' }, 404);
    return json(c, template);
  });

  app.get('/:project/api/v1/workflow-templates/:id/gates', async (c) => {
    const result = await checkWorkflowTemplateGates(getCtx(c.req.param('project')), c.req.param('id'));
    if (!result) return json(c, { error: '工作流模板不存在' }, 404);
    return json(c, result);
  });

  app.get('/:project/api/v1/contract-proposals', async (c) => {
    const slug = c.req.param('project');
    const status = c.req.query('status');
    const parsed = status === undefined ? null : ProposalStatus.safeParse(status);
    if (parsed !== null && !parsed.success) return json(c, { error: parsed.error.message }, 400);
    return json(c, await listProposals(getCtx(slug), parsed?.data));
  });

  app.get('/:project/api/v1/gap/baseline', async (c) => {
    const slug = c.req.param('project');
    const baseline = await getCtx(slug).gap.getBaseline();
    if (!baseline) return json(c, { bom_commit: null });
    return json(c, { bom_commit: baseline.bom_commit, updated_at: baseline.updated_at });
  });

  app.post('/:project/api/v1/gap/baseline', async (c) => {
    const slug = c.req.param('project');
    const parsed = BomBaselineInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await setBaseline(getCtx(slug), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, 400);
    }
  });

  app.post('/:project/api/v1/gap/evidence', async (c) => {    const slug = c.req.param('project');
    const body = await c.req.json();
    if (body.constraints !== undefined) {
      return json(c, { error: 'constraints 不再随证据上报——请先 POST /gap/constraints 注册约束集，再以 constraintSetId 引用' }, 400);
    }
    // items 逐项规范化（camelCase 别名），payload 原样传递
    const itemsRaw = Array.isArray(body.items) ? body.items : [];
    const items = itemsRaw.map((it: any) => ({
      source_id: it.source_id ?? it.sourceId,
      payload: it.payload,
      reported_at: it.reported_at ?? it.reportedAt,
      baseline_commit: it.baseline_commit ?? it.baselineCommit,
    }));
    const constraintSetId = body.constraint_set_id ?? body.constraintSetId;
    const parsed = EvidenceReportInput.safeParse({
      items,
      ...(constraintSetId !== undefined ? { constraint_set_id: constraintSetId } : {}),
    });
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      // 证据上报只写证据并重算；绝不推进基线（r-vb2b）
      return json(c, await reportEvidence(getCtx(slug), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, /^未设基准/.test(e.message) ? 409 : 400);
    }
  });

  app.post('/:project/api/v1/gap/constraints', async (c) => {
    const slug = c.req.param('project');
    const parsed = ConstraintSetInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await registerConstraintSet(getCtx(slug), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, 409);
    }
  });

  app.get('/:project/api/v1/gap/constraints', async (c) => {
    return json(c, await listConstraintSets(getCtx(c.req.param('project'))));
  });

  app.get('/:project/api/v1/gap/constraints/:id', async (c) => {
    const set = await getCtx(c.req.param('project')).gap.getConstraintSet(c.req.param('id'));
    if (!set) return json(c, { error: '约束集不存在' }, 404);
    return json(c, {
      id: set.set_id,
      hash: set.set_hash,
      item_count: set.constraints.length,
      created_at: set.created_at,
      items: set.constraints,
    });
  });

  app.post('/:project/api/v1/gap/waivers', async (c) => {
    const slug = c.req.param('project');
    const parsed = WaiverInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    // fingerprint 字段即 condition_fingerprint：按 open 行反查，每行存 (条件指纹+证据源) 键的豁免
    const count = await signWaiversByCondition(
      getCtx(slug), parsed.data.fingerprint, parsed.data.reason, parsed.data.expires_at ?? null,
    );
    if (count === 0) return json(c, { error: '无匹配的 open 差距行' }, 404);
    return json(c, { ok: true });
  });

  app.get('/:project/api/v1/gap/evidence', async (c) => {
    const slug = c.req.param('project');
    const key = c.req.query('requirement_key') ?? c.req.query('requirementKey');
    if (!key) return json(c, { error: '缺少 requirement_key' }, 400);
    return json(c, await buildEvidenceScene(getCtx(slug), key));
  });

  app.get('/:project/api/v1/gap/evidence/history', async (c) => {
    const slug = c.req.param('project');
    const sourceId = c.req.query('source_id') ?? c.req.query('sourceId');
    if (!sourceId) return json(c, { error: '缺少 source_id' }, 400);
    return json(c, await getCtx(slug).gap.getEvidenceHistory(sourceId));
  });

  app.post('/:project/api/v1/gap/reconcile', async (c) => {
    const slug = c.req.param('project');
    try {
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
      const constraintSetId = (body.constraint_set_id ?? body.constraintSetId) as string | undefined;
      return json(c, await reconcile(getCtx(slug), undefined, undefined, constraintSetId));
    } catch (e: any) {
      return json(c, { error: e.message }, /^未设基准/.test(e.message) ? 409 : 400);
    }
  });

  app.get('/:project/api/v1/helm', async (c) => {
    const slug = c.req.param('project');
    return json(c, await getHelmSignals(getCtx(slug)));
  });

  app.get('/:project/api/v1/activity', async (c) => {
    const slug = c.req.param('project');
    const limit = c.req.query('limit');
    const clamped = limit ? Math.min(Math.max(Number(limit), 1), 200) : undefined;
    return json(c, await recentActivity(getCtx(slug), clamped));
  });

  app.get('/:project/api/v1/fts', async (c) => {
    const slug = c.req.param('project');
    const q = c.req.query('q');
    if (!q) return json(c, { error: '缺少查询参数 "q"' }, 400);
    return json(c, await fullTextSearch(getCtx(slug), q));
  });

  // === 知识蒸馏 & 对话 ===

  app.post('/:project/api/v1/knowledge/distill', async (c) => {
    const slug = c.req.param('project');
    const body = await c.req.json();
    const { text, domain, source } = body as { text: string; domain?: string; source?: string };
    if (!text) return json(c, { error: '缺少 "text" 字段' }, 400);

    const ctx = getCtx(slug);
    const treeResult = await getKnowledgeTree(ctx);
    const anchors = treeResult.tree.filter((n: any) => n.pinned);
    const anchorSummary = anchors.map((a: any) =>
      `- id="${a.id}" title="${a.title}" domain="${a.domain}" (子项: ${a.children.length})`
    ).join('\n');
    const existingFlat = treeResult.tree.flatMap((n: any) => {
      const items = [{ id: n.id, title: n.title, domain: n.domain }];
      for (const ch of n.children) items.push({ id: ch.id, title: ch.title, domain: ch.domain });
      return items;
    });
    const existingSummary = existingFlat.slice(0, 40)
      .map((k: any) => `- id="${k.id}" [${k.domain}] ${k.title}`).join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个 AI-first 知识库工程师。用户提供零散文本，你需要决定如何将其整合到知识库中。

## 当前知识库锚点（顶层主题，人工设定，不可移动）：
${anchorSummary || '（暂无锚点）'}

## 已有知识条目：
${existingSummary || '（暂无）'}

## 你的决策

对于提取的每个知识点，你必须决定 action：
- "create": 创建全新条目
- "update": 更新已有条目（提供 target_id）
- "merge": 将多个已有条目合并为一个新条目（提供 merge_ids）

## 输出 JSON 格式：
{
  "actions": [
    {
      "action": "create",
      "title": "简洁标题",
      "description": "一句话摘要",
      "content": "详细内容（markdown）",
      "domain": "领域",
      "confidence": "low|medium|high",
      "parent_id": "父节点ID（匹配锚点或已有条目）或 null",
      "tags": []
    },
    {
      "action": "update",
      "target_id": "要更新的条目ID",
      "title": "更新后标题（可选）",
      "description": "更新后摘要（可选）",
      "content": "更新后详细内容（可选）",
      "domain": "领域（可选）"
    },
    {
      "action": "merge",
      "merge_ids": ["id1", "id2"],
      "title": "合并后标题",
      "description": "合并后摘要",
      "content": "合并后详细内容",
      "domain": "领域",
      "parent_id": "父节点ID 或 null"
    }
  ],
  "summary": "简要说明做了什么操作"
}

## 规则：
- 优先更新已有条目而非创建重复条目
- 如果多个碎片讨论同一主题，考虑合并
- parent_id 优先匹配锚点，无合适锚点时设为 null
- content 使用 markdown 格式，可以较长
- 如果文本无实质知识内容，返回空 actions 数组`,
      },
      { role: 'user', content: text },
    ];

    interface DistillAction {
      action: 'create' | 'update' | 'merge';
      target_id?: string;
      merge_ids?: string[];
      title?: string;
      description?: string;
      content?: string;
      domain?: string;
      confidence?: 'low' | 'medium' | 'high';
      parent_id?: string | null;
      tags?: string[];
    }
    interface DistillResult { actions: DistillAction[]; summary: string; }

    try {
      const result = await jsonCompletion<DistillResult>(messages);
      const created: any[] = [];
      const updated: any[] = [];
      const merged: any[] = [];

      for (const act of result.actions) {
        if (act.action === 'create') {
          const res = await recordKnowledge(ctx, {
            title: act.title!,
            description: act.description || '',
            content: act.content || '',
            domain: act.domain || domain || 'general',
            confidence: act.confidence || 'medium',
            source: source || 'distill',
            parent_id: act.parent_id,
            tags: act.tags,
          });
          created.push(res.knowledge);
        } else if (act.action === 'update' && act.target_id) {
          const res = await updateKnowledge(ctx, {
            knowledge_id: act.target_id,
            title: act.title,
            description: act.description,
            content: act.content,
            domain: act.domain,
          });
          updated.push(res.knowledge);
        } else if (act.action === 'merge' && act.merge_ids?.length) {
          // LLM 可能给出不存在/非 knowledge 的 ID：只取代真实知识节点，避免整批 distill 因 invalidates 拒绝而失败
          const mergeIds: string[] = [];
          for (const id of act.merge_ids) {
            const node = await ctx.nodes.getById(id);
            if (node?.type === 'knowledge') mergeIds.push(id);
          }
          const res = await recordKnowledge(ctx, {
            title: act.title!,
            description: act.description || '',
            content: act.content || '',
            domain: act.domain || domain || 'general',
            confidence: act.confidence || 'medium',
            source: source || 'distill-merge',
            parent_id: act.parent_id,
            invalidates: mergeIds,
            tags: act.tags,
          });
          merged.push(res.knowledge);
        }
      }

      return json(c, { created, updated, merged, summary: result.summary });
    } catch (e: any) {
      return json(c, { error: e.message }, 500);
    }
  });

  app.post('/:project/api/v1/knowledge/chat', async (c) => {
    const slug = c.req.param('project');
    const body = await c.req.json();
    const { messages: userMessages, action } = body as {
      messages: ChatMessage[];
      action?: 'chat' | 'save';
    };
    if (!userMessages || !Array.isArray(userMessages)) {
      return json(c, { error: '缺少 "messages" 数组' }, 400);
    }

    const ctx = getCtx(slug);
    const existing = await knowledgeMap(ctx);
    const existingSummary = (existing.knowledge || []).slice(0, 30)
      .map((k: any) => `- [${k.domain}] ${k.title}: ${k.description?.slice(0, 60) || ''}`).join('\n');

    const systemMsg: ChatMessage = {
      role: 'system',
      content: `你是一个知识管理助手，帮助用户整理和归纳项目知识。

当前知识库概览：
${existingSummary || '（暂无）'}

你可以：
1. 回答用户关于现有知识的问题
2. 帮助用户把零散想法整理为结构化知识
3. 当用户确认要保存时，输出以下 JSON 格式（用 \`\`\`json 包裹）：
\`\`\`json
{"save": [{"title": "...", "description": "...", "domain": "...", "confidence": "medium", "tags": []}]}
\`\`\`

在普通对话中不要输出 JSON，只在用户明确说"保存"、"记录"、"存入知识库"时才输出。`,
    };

    const fullMessages = [systemMsg, ...userMessages];

    try {
      const llmRes = await chatCompletion(fullMessages);
      let saved: any[] = [];

      if (action === 'save' || llmRes.content.includes('"save"')) {
        const jsonMatch = llmRes.content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed.save && Array.isArray(parsed.save)) {
              for (const item of parsed.save) {
                const res = await recordKnowledge(ctx, {
                  title: item.title,
                  description: item.description,
                  domain: item.domain || 'general',
                  confidence: item.confidence || 'medium',
                  source: item.source || 'chat',
                  tags: item.tags,
                });
                saved.push(res.knowledge);
              }
            }
          } catch { /* JSON parse failed, just return the message */ }
        }
      }

      return json(c, { reply: llmRes.content, reasoning: llmRes.reasoning || null, saved });
    } catch (e: any) {
      return json(c, { error: e.message }, 500);
    }
  });

  // === 项目级写操作 ===

  app.post('/:project/api/v1/operations/:name', async (c) => {
    const slug = c.req.param('project');
    const name = c.req.param('name');
    const snakeName = kebabToSnake(name);
    const handler = operationHandlers[snakeName];
    if (!handler) {
      return json(c, { error: `Unknown operation: ${name}` }, 404);
    }

    try {
      const ctx = getCtx(slug);
      const input = await c.req.json();
      const snakeInput = camelToSnake(input);
      const result = await handler(ctx, snakeInput);
      return json(c, result);
    } catch (e: any) {
      return json(c, { error: e.message }, 400);
    }
  });

  app.post('/:project/api/v1/batch', async (c) => {
    const slug = c.req.param('project');
    try {
      const ctx = getCtx(slug);
      const input = await c.req.json();
      const snakeInput = camelToSnake(input) as BatchOperationsInput;
      const result = await batchOperations(ctx, snakeInput, operationHandlers);
      return json(c, result);
    } catch (e: any) {
      return json(c, { error: e.message }, 400);
    }
  });

  // === Cloud 路由（原 si-beaver-cloud）===

  app.get('/health', (c) => c.json({
    status: 'ok',
    service: 'sibeaver',
    version: '0.2.0',
    uptime: process.uptime(),
  }));

  app.get('/api/v1/config', (c) => c.json({
    sibsProject: config.sibsProject,
    llmModel: config.llmModel,
  }));

  return app;
}

// ============================================================
// createSiBeaverApp — 工厂函数，不启动 HTTP server
// ============================================================

export interface SiBeaverApp {
  app: Hono;
  manager: ProjectManager;
  handleMcpRequest: typeof handleMcpRequest;
}

export function createSiBeaverApp(authToken?: string): SiBeaverApp {
  const manager = new ProjectManager();
  const app = createHonoApp(manager, authToken);
  return { app, manager, handleMcpRequest };
}

// ============================================================
// start — 独立模式：创建 HTTP server 并启动（含 cloud 事件总线）
// ============================================================

async function start() {
  const authToken = process.env.AUTH_TOKEN || process.env.SI_BEAVER_AUTH_TOKEN;
  if (authToken) {
    console.log('[sibs] Auth token configured');
  } else {
    console.warn('[sibs] No AUTH_TOKEN set — API routes will be unauthenticated');
  }

  const { app, manager, handleMcpRequest } = createSiBeaverApp(authToken);

  await manager.init();

  const projectSlug = config.sibsProject || await manager.getDefaultProject();
  console.log(`[sibs] project=${projectSlug}`);

  // Direct-mode bridge — 服务端直连 sibs-client（无 HTTP 往返）
  setDirectSibs(buildDirectSibs(manager, projectSlug));

  const honoListener = getRequestListener(app.fetch);
  const MCP_PATH = /^\/([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])\/mcp$/;

  const httpServer = createServer(async (req, res) => {
    const pathname = req.url?.split('?')[0] ?? '/';

    if (MCP_PATH.test(pathname) && req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.writeHead(204);
      res.end();
      return;
    }

    if (MCP_PATH.test(pathname)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      // @sibom r-mp3c — MCP 路由同样要求 Bearer Token；未配置认证时开放内网访问
      if (authToken) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${authToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      const handled = await handleMcpRequest(req, res, manager);
      if (handled) return;
    }

    honoListener(req, res);
  });

  httpServer.timeout = 0;
  httpServer.keepAliveTimeout = 120_000;

  const PORT = Number(process.env.PORT) || Number(process.env.SI_BEAVER_PORT) || 7420;

  httpServer.listen(PORT, () => {
    console.log(`sibs running at http://localhost:${PORT}`);
    console.log(`  REST API: http://localhost:${PORT}/{project}/api/v1/...`);
    console.log(`  MCP:      http://localhost:${PORT}/{project}/mcp`);
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`[sibs] Received ${signal}, shutting down...`);
    httpServer.close(() => {
      console.log('[sibs] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[sibs] Forced shutdown after timeout');
      process.exit(1);
    }, 15000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ============================================================
// Direct-mode bridges — 将 operationHandlers 桥接到 sibs 接口
// ============================================================

function buildDirectSibs(manager: ProjectManager, slug: string): DirectSibsContext {
  const getCtx = () => manager.getContext(slug);

  return {
    getProjectState: () => getProjectState(getCtx()) as any,
    getNodeContext: (nodeId: string) => getNodeContext(getCtx(), nodeId) as any,

    defineWitem: (input: any) =>
      operationHandlers.define_witem(getCtx(), camelToSnake(input)),

    updateRequirementStatus: (input: any) =>
      operationHandlers.update_requirement_status(getCtx(), camelToSnake(input)),

    linkNodes: (input: any) =>
      operationHandlers.link_nodes(getCtx(), camelToSnake(input)),

    recordKnowledge: (input: any) =>
      operationHandlers.record_knowledge(getCtx(), camelToSnake(input)),

    identifyRisk: (input: any) =>
      operationHandlers.identify_risk(getCtx(), camelToSnake(input)),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('server.js') || entry.endsWith('server.ts') ||
         entry.includes('/api/server.');
}

if (isMainModule()) {
  start().catch((err) => {
    console.error('Failed to start si-beaver:', err);
    process.exit(1);
  });
}
