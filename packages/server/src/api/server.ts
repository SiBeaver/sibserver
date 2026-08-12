import { createServer } from 'node:http';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getRequestListener } from '@hono/node-server';
import { handleMcpRequest } from '../mcp/http-server.js';
import { chatCompletion, jsonCompletion, type ChatMessage } from '../llm-client.js';
import type { OperationContext, BatchOperationsInput } from '../index.js';
import {
  defineGoal, decomposeGoal, updateGoalStatus,
  beginExploration, recordExplorationFinding, concludeExploration, abandonExploration,
  recordDecision,
  defineRequirement, updateRequirementStatus, updateRequirementAcceptance,
  identifyRisk, updateRisk, registerTechDebt,
  recordKnowledge, updateKnowledge, getKnowledgeTree, pinKnowledge, moveKnowledge,
  linkNodes, deleteNode, getProjectState, getNodeContext,
  getRoadmap, goalProgress, decisionTrail, knowledgeMap,
  staleItems, currentBlockers, recentActivity, fullTextSearch,
  getHelmSignals,
  batchOperations,
  generateProjection, listProjectionTypes,
  distillConversation,
} from '../index.js';
import { ProjectManager } from '../projects/index.js';
import { startEmbedSync, getEmbedSyncStats } from '../jobs/embed-sync.js';
import { startLinkRepair, getLinkRepairStats } from '../jobs/link-repair.js';
import { startPoller, onEvent, setDirectEventSource } from '../event-poller.js';
import type { DirectEventSource } from '../event-poller.js';
import { setDirectSibs } from '../sibs-client.js';
import type { DirectSibsContext } from '../sibs-client.js';
import { config } from '../config/index.js';
import { generateEmbeddings, getEmbeddingConfig } from '../embedding/client.js';
import { snakeToCamel, camelToSnake, kebabToSnake } from './transforms.js';
import { handleRequirementAccepted } from '../policies/triggers/requirement-trigger.js';
import { handleKnowledgeRecorded } from '../policies/self-heal.js';
import { evaluateAcceptanceGap, evaluateAllAcceptanceGaps } from '../policies/acceptance-evaluator.js';
import { evaluateConstraints, summarizeResults } from '../policies/constraint-evaluator.js';
import type { Constraint, EvidenceInput } from '@sibeaver/core';
import { setBaseline, reportEvidence, reconcile, listGaps, buildEvidenceScene } from '../gap/engine.js';
import { BomSnapshot, EvidenceItemInput, WaiverInput } from '@sibeaver/core';

// ============================================================
// 操作处理器注册表（导出供 direct-mode 调用方使用）
// ============================================================

export const operationHandlers: Record<string, (ctx: OperationContext, input: any) => Promise<any>> = {
  define_goal: defineGoal,
  decompose_goal: decomposeGoal,
  update_goal_status: updateGoalStatus,
  begin_exploration: beginExploration,
  record_exploration_finding: recordExplorationFinding,
  conclude_exploration: concludeExploration,
  abandon_exploration: abandonExploration,
  record_decision: recordDecision,
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
  generate_projection: generateProjection,
  list_projections: listProjectionTypes,
};

// ============================================================
// createHonoApp — 创建配置好所有路由的 Hono app
// ============================================================

function createHonoApp(manager: ProjectManager, authToken?: string): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/api/*', cors());
  app.use('/:project/api/*', cors());

  if (authToken) {
    const authMw = async (c: any, next: any) => {
      const auth = c.req.header('Authorization');
      if (auth !== `Bearer ${authToken}`) {
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

  app.get('/api/v1/stats/embedding', (c) => {
    return c.json(getEmbedSyncStats());
  });

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
    return json(c, events);
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

  app.get('/:project/api/v1/search', async (c) => {
    const slug = c.req.param('project');
    const q = c.req.query('q');
    if (!q) return json(c, { error: '缺少查询参数 "q"' }, 400);
    return json(c, await getCtx(slug).nodes.search(q));
  });

  app.get('/:project/api/v1/search/semantic', async (c) => {
    const slug = c.req.param('project');
    const q = c.req.query('q');
    if (!q) return json(c, { error: '缺少查询参数 "q"' }, 400);
    if (!getEmbeddingConfig()) {
      return json(c, { error: '语义搜索不可用：未配置 EMBEDDING_API_KEY' }, 503);
    }
    const topK = Math.min(Number(c.req.query('top_k')) || 10, 50);
    try {
      const [vec] = await generateEmbeddings([q]);
      const results = await getCtx(slug).nodes.similaritySearch(vec, topK);
      return json(c, results);
    } catch (e: any) {
      return json(c, { error: e.message }, 500);
    }
  });

  app.get('/:project/api/v1/events', async (c) => {
    const slug = c.req.param('project');
    const since = c.req.query('since');
    const limit = c.req.query('limit');
    const ctx = getCtx(slug);
    if (since) return json(c, await ctx.eventStore.getSince(since));
    return json(c, await ctx.eventStore.getRecent(Number(limit) || 20));
  });

  app.get('/:project/api/v1/roadmap', async (c) => {
    const slug = c.req.param('project');
    const rootGoal = c.req.query('root-goal');
    const includeCompleted = c.req.query('include-completed') === 'true';
    const maxDepth = c.req.query('max-depth');
    try {
      const result = await getRoadmap(getCtx(slug), {
        root_goal: rootGoal || undefined,
        include_completed: includeCompleted,
        max_depth: maxDepth ? Number(maxDepth) : undefined,
      });
      return json(c, result);
    } catch (e: any) {
      return json(c, { error: e.message }, 404);
    }
  });

  app.get('/:project/api/v1/goals/progress', async (c) => {
    const slug = c.req.param('project');
    return json(c, await goalProgress(getCtx(slug)));
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
    return json(c, { goals: state.active_goals, requirements: state.requirements, blockers: blockers.blockers });
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

  app.get('/:project/api/v1/requirements/:id/gap', async (c) => {
    const slug = c.req.param('project');
    const id = c.req.param('id');
    try {
      return json(c, await evaluateAcceptanceGap(getCtx(slug), id));
    } catch (e: any) {
      return json(c, { error: e.message }, 404);
    }
  });

  app.get('/:project/api/v1/gaps', async (c) => {
    const slug = c.req.param('project');
    const ledger = await listGaps(getCtx(slug));
    if (ledger.bom_commit === null) {
      // 未设基准：回退旧验收对账（内存计算），便于基准落地前过渡
      const gaps = await evaluateAllAcceptanceGaps(getCtx(slug));
      return json(c, { ...ledger, acceptance_gaps: gaps });
    }
    return json(c, ledger);
  });

  app.get('/:project/api/v1/gap/baseline', async (c) => {
    const slug = c.req.param('project');
    const baseline = await getCtx(slug).gap.getBaseline();
    if (!baseline) return json(c, { bom_commit: null });
    return json(c, { bom_commit: baseline.bom_commit, updated_at: baseline.updated_at });
  });

  app.post('/:project/api/v1/gap/baseline', async (c) => {
    const slug = c.req.param('project');
    const parsed = BomSnapshot.safeParse(await c.req.json());
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    return json(c, await setBaseline(getCtx(slug), parsed.data));
  });

  app.post('/:project/api/v1/gap/evidence', async (c) => {
    const slug = c.req.param('project');
    const body = await c.req.json();
    const parsed = EvidenceItemInput.array().safeParse(body.items ?? []);
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    try {
      return json(c, await reportEvidence(getCtx(slug), parsed.data));
    } catch (e: any) {
      return json(c, { error: e.message }, 409);
    }
  });

  app.post('/:project/api/v1/gap/waivers', async (c) => {
    const slug = c.req.param('project');
    const parsed = WaiverInput.safeParse(camelToSnake(await c.req.json()));
    if (!parsed.success) return json(c, { error: parsed.error.message }, 400);
    await getCtx(slug).gap.upsertWaiver({
      fingerprint: parsed.data.fingerprint,
      reason: parsed.data.reason,
      expires_at: parsed.data.expires_at ?? null,
      created_at: new Date().toISOString(),
    });
    return json(c, { ok: true });
  });

  app.get('/:project/api/v1/gap/evidence', async (c) => {
    const slug = c.req.param('project');
    const key = c.req.query('requirement_key') ?? c.req.query('requirementKey');
    if (!key) return json(c, { error: '缺少 requirement_key' }, 400);
    return json(c, await buildEvidenceScene(getCtx(slug), key));
  });

  app.post('/:project/api/v1/gap/reconcile', async (c) => {
    const slug = c.req.param('project');
    try {
      return json(c, await reconcile(getCtx(slug)));
    } catch (e: any) {
      return json(c, { error: e.message }, 409);
    }
  });

  app.post('/:project/api/v1/constraints/evaluate', async (c) => {
    const slug = c.req.param('project');
    const body = await c.req.json();
    const constraints = (body.constraints ?? []) as Constraint[];
    const evidence = (body.evidence ?? {}) as EvidenceInput;
    const results = await evaluateConstraints(constraints, evidence, getCtx(slug));
    return json(c, { results, summary: summarizeResults(results) });
  });

  app.get('/:project/api/v1/helm', async (c) => {
    const slug = c.req.param('project');
    return json(c, await getHelmSignals(getCtx(slug)));
  });

  app.get('/:project/api/v1/projections', async (c) => {
    const slug = c.req.param('project');
    const project = await manager.getProject(slug);
    if (!project) return json(c, { error: '项目不存在' }, 404);
    const types = await listProjectionTypes();
    const configured = (project.metadata?.projections ?? {}) as Record<string, any>;
    return json(c, {
      available_types: types,
      configured: Object.entries(configured).map(([key, cfg]: [string, any]) => ({
        ...cfg,
        id: key,
      })),
    });
  });

  app.post('/:project/api/v1/projections/:type/generate', async (c) => {
    const slug = c.req.param('project');
    const type = c.req.param('type');
    const project = await manager.getProject(slug);
    if (!project) return json(c, { error: '项目不存在' }, 404);
    const projections = (project.metadata?.projections ?? {}) as Record<string, any>;
    const config = projections[type];
    if (!config) {
      return json(c, { error: `No projection config for type "${type}"` }, 400);
    }
    try {
      const result = await generateProjection(getCtx(slug), { type, config });
      return json(c, result);
    } catch (e: any) {
      return json(c, { error: e.message }, 400);
    }
  });

  app.get('/:project/api/v1/activity', async (c) => {
    const slug = c.req.param('project');
    const limit = c.req.query('limit');
    return json(c, await recentActivity(getCtx(slug), limit ? Number(limit) : undefined));
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
          const res = await recordKnowledge(ctx, {
            title: act.title!,
            description: act.description || '',
            content: act.content || '',
            domain: act.domain || domain || 'general',
            confidence: act.confidence || 'medium',
            source: source || 'distill-merge',
            parent_id: act.parent_id,
            invalidates: act.merge_ids,
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

  // === 对话蒸馏 ===

  app.post('/:project/api/v1/conversation/distill', async (c) => {
    const slug = c.req.param('project');
    const body = await c.req.json();
    try {
      const result = await distillConversation(getCtx(slug), body);
      return json(c, result);
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
    pollInterval: config.pollInterval,
  }));

  app.get('/api/v1/stats/link-repair', (c) => c.json(getLinkRepairStats()));

  app.post('/api/v1/policies/from-requirement', async (c) => {
    const body = await c.req.json();
    const requirementId = body.requirementId;
    if (!requirementId) return c.json({ error: '缺少 requirementId' }, 400);

    const fakeEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      eventType: 'requirement.status_changed',
      actor: 'system',
      operation: 'trigger-policy',
      nodeId: requirementId,
      nodeType: 'requirement',
      payload: {},
      diff: [{ field: 'status', oldValue: 'proposed', newValue: 'accepted' }],
      context: null,
    };

    handleRequirementAccepted(fakeEvent as any).catch(err => {
      console.error('[policies/from-requirement] error:', err);
    });

    return c.json({ message: 'policy triggered', requirementId }, 202);
  });

  app.post('/api/v1/distill/refine', async (c) => {
    const body = await c.req.json();
    const { requirementId, message } = body;
    if (!requirementId) return c.json({ error: '缺少 requirementId' }, 400);
    if (!message) return c.json({ error: '缺少 message' }, 400);

    const { sibs } = await import('../sibs-client.js');
    const { chatCompletion } = await import('../llm-client.js');
    const ctx = await sibs.getNodeContext(requirementId);
    const node = ctx.node as any;
    if (!node) return c.json({ error: '需求不存在' }, 404);

    const state = await sibs.getProjectState();

    const messages = [
      {
        role: 'system',
        content: `你是 Distill Agent，负责帮助用户精炼需求。你的职责：
1. 分析需求的 WHY 是否清晰（来源、动机、裁剪理由）
2. 检测与现有需求的潜在冲突
3. 识别缺失的维度
4. 建议补充描述

当前项目有 ${state.requirements.length} 个需求。

当前需求：
标题: ${node.title}
描述: ${node.description || '无'}
来源: ${node.source ?? '未知'}
状态: ${node.status}

现有已接受的需求（用于冲突检测）：
${state.requirements.filter((r: any) => r.id !== requirementId).map((r: any) => `- ${r.title}`).join('\n') || '无'}

请用中文回答，给出具体可操作的建议。`,
      },
      { role: 'user', content: message },
    ];

    const response = await chatCompletion(messages as any);
    return c.json({ reply: response.content, usage: response.usage });
  });

  app.post('/api/v1/distill/check-conflicts', async (c) => {
    const body = await c.req.json();
    const { requirementId } = body;
    if (!requirementId) return c.json({ error: '缺少 requirementId' }, 400);

    const { sibs } = await import('../sibs-client.js');
    const { chatCompletion } = await import('../llm-client.js');
    const ctx = await sibs.getNodeContext(requirementId);
    const node = ctx.node as any;
    if (!node) return c.json({ error: '需求不存在' }, 404);

    const state = await sibs.getProjectState();
    const others = state.requirements.filter(
      (r: any) => r.id !== requirementId && !['deprecated', 'satisfied'].includes(r.status)
    );

    if (others.length === 0) {
      return c.json({ requirementId, conflicts: [], message: '无其他活跃需求' });
    }

    const messages = [
      {
        role: 'system',
        content: `分析以下需求是否与现有需求存在冲突或重叠。输出 JSON:
{ "conflicts": [{ "id": "...", "title": "...", "overlap": "high|medium|low", "reason": "..." }] }
只报告 medium 或 high 重叠的。`,
      },
      {
        role: 'user',
        content: `目标需求:
标题: ${node.title}
描述: ${node.description || '无'}

现有需求:
${others.map((r: any) => `- [${r.id.slice(0, 8)}] ${r.title}: ${r.description || '无描述'}`).join('\n')}`,
      },
    ];

    try {
      const result = await chatCompletion(messages as any, { temperature: 0.2 });
      const parsed = JSON.parse(result.content);
      return c.json({ requirementId, ...parsed });
    } catch {
      return c.json({ requirementId, conflicts: [], error: 'LLM 解析失败' });
    }
  });

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
  startEmbedSync(manager);
  if (config.linkRepairEnabled) {
    startLinkRepair(manager);
  } else {
    console.log('[link-repair] Disabled by LINK_REPAIR_ENABLED=false');
  }

  const projectSlug = config.sibsProject || await manager.getDefaultProject();
  console.log(`[sibs] project=${projectSlug}`);

  // Direct-mode bridges — policies call sibs.* without HTTP roundtrip
  setDirectSibs(buildDirectSibs(manager, projectSlug));
  setDirectEventSource(buildDirectEventSource(manager, projectSlug));

  // Cloud event handlers
  onEvent('requirement.status_changed', handleRequirementAccepted);
  onEvent('knowledge.recorded', handleKnowledgeRecorded);

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

    startPoller();
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

    getEvents: async (since?: string, limit = 50) => {
      const ctx = getCtx();
      if (since) {
        const events = await ctx.eventStore.getSince(since);
        return { events: events as any[] };
      }
      const events = await ctx.eventStore.getRecent(limit);
      return { events: events as any[] };
    },

    defineGoal: (input: any) =>
      operationHandlers.define_goal(getCtx(), camelToSnake(input)),

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

function buildDirectEventSource(manager: ProjectManager, slug: string): DirectEventSource {
  return {
    getEvents: async (since?: string, limit = 50) => {
      const ctx = manager.getContext(slug);
      if (since) {
        const events = await ctx.eventStore.getSince(since);
        return { events: events as any[] };
      }
      const events = await ctx.eventStore.getRecent(limit);
      return { events: events as any[] };
    },
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
