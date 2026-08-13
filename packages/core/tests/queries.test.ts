import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db.js';
import type { Sql } from '../src/storage/db.js';
import { OperationContext } from '../src/operations/context.js';
import {
  defineWitem, decomposeWitem, updateWitemStatus,
  recordDecision,
  identifyRisk, registerTechDebt,
  recordKnowledge,
  getRoadmap, witemProgress, decisionTrail, knowledgeMap,
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
      const witem = await defineWitem(ctx, { title: '顶层目标', horizon: 'long', priority: 'high' });
      await decomposeWitem(ctx, {
        witem_id: witem.witem.id,
        sub_witems: [{ title: '子目标1', horizon: 'short' }],
      });

      const result = await getRoadmap(ctx);
      expect(result.roadmap).toHaveLength(1);
      expect(result.roadmap[0].node.id).toBe(witem.witem.id);
      expect(result.roadmap[0].children).toHaveLength(1);
      expect(result.roadmap[0].progress.total).toBe(1);
      expect(result.roadmap[0].progress.done).toBe(0);
    });

    it('应该支持指定根目标', async () => {
      const parent = await defineWitem(ctx, { title: '父', horizon: 'long', priority: 'high' });
      const decomposed = await decomposeWitem(ctx, {
        witem_id: parent.witem.id,
        sub_witems: [{ title: '子', horizon: 'short' }],
      });

      const childId = decomposed.sub_witems_created[0].id;
      const result = await getRoadmap(ctx, { root_witem: childId });
      expect(result.roadmap).toHaveLength(1);
      expect(result.roadmap[0].node.id).toBe(childId);
    });

    it('应该过滤已完成目标（默认）', async () => {
      const witem = await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      await updateWitemStatus(ctx, {
        witem_id: witem.witem.id,
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
  // witemProgress
  // ============================================================

  describe('witemProgress', () => {
    it('应该返回空进度', async () => {
      const result = await witemProgress(ctx);
      expect(result.witems).toHaveLength(0);
    });

    it('应该计算目标子项完成率', async () => {
      const witem = await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const child1 = await defineWitem(ctx, { title: '子项1', horizon: 'short', priority: 'medium', parent_witem: witem.witem.id });
      const child2 = await defineWitem(ctx, { title: '子项2', horizon: 'short', priority: 'medium', parent_witem: witem.witem.id });

      // 完成其中一个子项
      await updateWitemStatus(ctx, { witem_id: child1.witem.id, new_status: 'achieved', reason: '完成' });

      const result = await witemProgress(ctx);
      expect(result.witems).toHaveLength(2);
      const parent = result.witems.find(w => w.total === 2)!;
      expect(parent.done).toBe(1);
      expect(parent.percentage).toBe(50);
    });
  });

  // ============================================================
  // decisionTrail
  // ============================================================

  describe('decisionTrail', () => {
    it('应该追溯决策链', async () => {
      const anchor = await defineWitem(ctx, { title: '锚', horizon: 'short', priority: 'medium' });
      const first = await recordDecision(ctx, {
        title: '旧决策', context: '情境', rationale: '原因',
        related_witems: [anchor.witem.id],
      });
      const second = await recordDecision(ctx, {
        title: '新决策', context: '情境', rationale: '原因',
        supersedes: first.decision.id,
      });

      const result = await decisionTrail(ctx, second.decision.id);

      expect(result.root.id).toBe(second.decision.id);
      expect(result.trail.some(t => t.node.id === first.decision.id)).toBe(true);
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
      const witem = await defineWitem(ctx, { title: '旧目标', horizon: 'short', priority: 'low' });
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const node = await ctx.nodes.getById(witem.witem.id)!;
      await ctx.nodes.update({ ...node, updated_at: oldDate } as any);

      const result = await staleItems(ctx, 7);
      expect(result.stale_items).toHaveLength(1);
      expect(result.stale_items[0].id).toBe(witem.witem.id);
    });

    it('不应该包含已完成的节点', async () => {
      const witem = await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'low' });
      await updateWitemStatus(ctx, { witem_id: witem.witem.id, new_status: 'achieved', reason: '完成' });

      // 手动设为过期
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const node = await ctx.nodes.getById(witem.witem.id)!;
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
      const witem = await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      await identifyRisk(ctx, {
        title: '阻塞风险',
        description: '问题',
        likelihood: 'high',
        impact: 'critical',
        affected_witems: [witem.witem.id],
      });

      const result = await currentBlockers(ctx);
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0].blocker.title).toBe('阻塞风险');
      expect(result.blockers[0].blocks).toHaveLength(1);
    });

    it('应该返回空列表（无阻塞）', async () => {
      await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const result = await currentBlockers(ctx);
      expect(result.blockers).toHaveLength(0);
    });
  });

  // ============================================================
  // recentActivity
  // ============================================================

  describe('recentActivity', () => {
    it('应该返回最近事件', async () => {
      await defineWitem(ctx, { title: '目标1', horizon: 'short', priority: 'high' });
      await defineWitem(ctx, { title: '目标2', horizon: 'short', priority: 'medium' });

      const result = await recentActivity(ctx, 10);
      expect(result.events.length).toBeGreaterThanOrEqual(2);
    });

    it('应该尊重 limit', async () => {
      await defineWitem(ctx, { title: '目标1', horizon: 'short', priority: 'high' });
      await defineWitem(ctx, { title: '目标2', horizon: 'short', priority: 'medium' });
      await defineWitem(ctx, { title: '目标3', horizon: 'short', priority: 'low' });

      const result = await recentActivity(ctx, 2);
      expect(result.events).toHaveLength(2);
    });
  });

  // ============================================================
  // fullTextSearch
  // ============================================================

  describe('fullTextSearch', () => {
    it('应该搜索节点标题和描述', async () => {
      await defineWitem(ctx, { title: 'WebSocket 重连', horizon: 'short', priority: 'high' });
      await defineWitem(ctx, { title: '普通工作项', horizon: 'short', priority: 'medium' });

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
