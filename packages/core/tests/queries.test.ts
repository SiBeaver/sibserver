import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db.js';
import type { Sql } from '../src/storage/db.js';
import { OperationContext } from '../src/operations/context.js';
import {
  defineGoal, decomposeGoal, updateGoalStatus,
  beginExploration, concludeExploration,
  recordDecision,
  createTask, updateTaskStatus,
  identifyRisk, registerTechDebt,
  recordKnowledge,
  getRoadmap, goalProgress, decisionTrail, knowledgeMap,
  staleItems, currentBlockers, recentActivity, fullTextSearch,
} from '../src/operations/index.js';

describe('Query Operations', () => {
  let sql: Sql;
  let close: () => void;
  let ctx: OperationContext;

  beforeEach(async () => {
    const test = await createTestDb();
    sql = test.sql;
    close = test.close;
    ctx = new OperationContext(sql, 'default');
  });

  afterEach(async () => {
    await close();
  });

  // ============================================================
  // getRoadmap
  // ============================================================

  describe('getRoadmap', () => {
    it('应该返回空路线图', async () => {
      const result = await getRoadmap(ctx);
      expect(result.roadmap).toHaveLength(0);
    });

    it('应该返回顶层目标树', async () => {
      const goal = await defineGoal(ctx, { title: '顶层目标', horizon: 'long', priority: 'high' });
      await decomposeGoal(ctx, {
        goal_id: goal.goal.id,
        sub_goals: [{ title: '子目标1', horizon: 'short' }],
      });

      const result = await getRoadmap(ctx);
      expect(result.roadmap).toHaveLength(1);
      expect(result.roadmap[0].node.id).toBe(goal.goal.id);
      expect(result.roadmap[0].children).toHaveLength(1);
      expect(result.roadmap[0].progress.total).toBe(1);
      expect(result.roadmap[0].progress.done).toBe(0);
    });

    it('应该支持指定根目标', async () => {
      const parent = await defineGoal(ctx, { title: '父', horizon: 'long', priority: 'high' });
      const decomposed = await decomposeGoal(ctx, {
        goal_id: parent.goal.id,
        sub_goals: [{ title: '子', horizon: 'short' }],
      });

      const childId = decomposed.sub_goals_created[0].id;
      const result = await getRoadmap(ctx, { root_goal: childId });
      expect(result.roadmap).toHaveLength(1);
      expect(result.roadmap[0].node.id).toBe(childId);
    });

    it('应该过滤已完成目标（默认）', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      await updateGoalStatus(ctx, {
        goal_id: goal.goal.id,
        new_status: 'achieved',
        reason: '完成',
      });

      const result = await getRoadmap(ctx);
      expect(result.roadmap).toHaveLength(0);

      const resultWithCompleted = await getRoadmap(ctx, { include_completed: true });
      expect(resultWithCompleted.roadmap).toHaveLength(1);
    });
  });

  // ============================================================
  // goalProgress
  // ============================================================

  describe('goalProgress', () => {
    it('应该返回空进度', async () => {
      const result = await goalProgress(ctx);
      expect(result.goals).toHaveLength(0);
    });

    it('应该计算目标子项完成率', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const t1 = await createTask(ctx, { title: '任务1', parent_goal: goal.goal.id });
      const t2 = await createTask(ctx, { title: '任务2', parent_goal: goal.goal.id });

      // 完成其中一个任务
      const taskId = t1.task.id;
      await updateTaskStatus(ctx, { task_id: taskId, new_status: 'in_progress' });
      await updateTaskStatus(ctx, { task_id: taskId, new_status: 'done' });

      const result = await goalProgress(ctx);
      expect(result.goals).toHaveLength(1);
      expect(result.goals[0].total).toBe(2);
      expect(result.goals[0].done).toBe(1);
      expect(result.goals[0].percentage).toBe(50);
    });
  });

  // ============================================================
  // decisionTrail
  // ============================================================

  describe('decisionTrail', () => {
    it('应该追溯决策链', async () => {
      const exp = await beginExploration(ctx, { topic: '探索', reason: '原因' });
      const concluded = await concludeExploration(ctx, {
        exploration_id: exp.exploration.id,
        conclusion: '结论',
        outcome: 'validated',
        decisions: [{ title: '决策', rationale: '原因' }],
      });

      const decisionId = concluded.decisions_created[0].id;
      const result = await decisionTrail(ctx, decisionId);

      expect(result.root.id).toBe(decisionId);
      expect(result.trail.length).toBeGreaterThanOrEqual(1);
      expect(result.trail.some(t => t.node.id === exp.exploration.id)).toBe(true);
    });

    it('应该拒绝不存在的节点', async () => {
      await expect(decisionTrail(ctx, 'nonexistent')).rejects.toThrow('节点不存在：nonexistent');
    });
  });

  // ============================================================
  // knowledgeMap
  // ============================================================

  describe('knowledgeMap', () => {
    it('应该按领域分组知识', async () => {
      await recordKnowledge(ctx, { title: 'K1', description: 'd', domain: 'db', source: 's' });
      await recordKnowledge(ctx, { title: 'K2', description: 'd', domain: 'db', source: 's' });
      await recordKnowledge(ctx, { title: 'K3', description: 'd', domain: 'api', source: 's' });

      const all = await knowledgeMap(ctx);
      expect(all.knowledge).toHaveLength(3);
      expect(Object.keys(all.by_domain)).toHaveLength(2);
      expect(all.by_domain['db']).toHaveLength(2);
      expect(all.by_domain['api']).toHaveLength(1);

      const filtered = await knowledgeMap(ctx, 'db');
      expect(filtered.knowledge).toHaveLength(2);
    });
  });

  // ============================================================
  // staleItems
  // ============================================================

  describe('staleItems', () => {
    it('应该返回过期节点', async () => {
      // 创建一个目标然后手动修改 updated_at 到过去
      const goal = await defineGoal(ctx, { title: '旧目标', horizon: 'short', priority: 'low' });
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const node = await ctx.nodes.getById(goal.goal.id)!;
      await ctx.nodes.update({ ...node, updated_at: oldDate } as any);

      const result = await staleItems(ctx, 7);
      expect(result.stale_items).toHaveLength(1);
      expect(result.stale_items[0].id).toBe(goal.goal.id);
    });

    it('不应该包含已完成的节点', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'low' });
      await updateGoalStatus(ctx, { goal_id: goal.goal.id, new_status: 'achieved', reason: '完成' });

      // 手动设为过期
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const node = await ctx.nodes.getById(goal.goal.id)!;
      await ctx.nodes.update({ ...node, updated_at: oldDate } as any);

      const result = await staleItems(ctx, 7);
      expect(result.stale_items).toHaveLength(0);
    });
  });

  // ============================================================
  // currentBlockers
  // ============================================================

  describe('currentBlockers', () => {
    it('应该找到阻塞目标的风险', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      await identifyRisk(ctx, {
        title: '阻塞风险',
        description: '问题',
        likelihood: 'high',
        impact: 'critical',
        affected_goals: [goal.goal.id],
      });

      const result = await currentBlockers(ctx);
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0].blocker.title).toBe('阻塞风险');
      expect(result.blockers[0].blocks).toHaveLength(1);
    });

    it('应该返回空列表（无阻塞）', async () => {
      await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const result = await currentBlockers(ctx);
      expect(result.blockers).toHaveLength(0);
    });
  });

  // ============================================================
  // recentActivity
  // ============================================================

  describe('recentActivity', () => {
    it('应该返回最近事件', async () => {
      await defineGoal(ctx, { title: '目标1', horizon: 'short', priority: 'high' });
      await defineGoal(ctx, { title: '目标2', horizon: 'short', priority: 'medium' });

      const result = await recentActivity(ctx, 10);
      expect(result.events.length).toBeGreaterThanOrEqual(2);
    });

    it('应该尊重 limit', async () => {
      await defineGoal(ctx, { title: '目标1', horizon: 'short', priority: 'high' });
      await defineGoal(ctx, { title: '目标2', horizon: 'short', priority: 'medium' });
      await defineGoal(ctx, { title: '目标3', horizon: 'short', priority: 'low' });

      const result = await recentActivity(ctx, 2);
      expect(result.events).toHaveLength(2);
    });
  });

  // ============================================================
  // fullTextSearch
  // ============================================================

  describe('fullTextSearch', () => {
    it('应该搜索节点标题和描述', async () => {
      await defineGoal(ctx, { title: 'WebSocket 重连', horizon: 'short', priority: 'high' });
      await createTask(ctx, { title: '普通任务' });

      const result = await fullTextSearch(ctx, 'WebSocket');
      expect(result.count).toBe(1);
      expect(result.results[0].title).toContain('WebSocket');
    });

    it('应该返回空结果', async () => {
      const result = await fullTextSearch(ctx, '不存在的关键词xyz');
      expect(result.count).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });
});
