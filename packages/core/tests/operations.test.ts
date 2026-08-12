import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db.js';
import type { Sql } from '../src/storage/db.js';
import { OperationContext } from '../src/operations/context.js';
import {
  defineWitem, decomposeWitem, updateWitemStatus,
  recordDecision, updateDecisionStatus,
  identifyRisk, updateRisk, registerTechDebt,
  recordKnowledge,
  linkNodes, getProjectState, getNodeContext,
  defineRequirement, updateRequirementStatus,
} from '../src/operations/index.js';

describe('Operations Layer', () => {
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
  // Goal Operations
  // ============================================================

  describe('defineWitem', () => {
    it('应该创建目标并返回事件', async () => {
      const result = await defineWitem(ctx, {
        title: '测试目标',
        horizon: 'short',
        priority: 'high',
        success_criteria: ['标准1'],
        tags: ['test'],
      });

      expect(result.witem.title).toBe('测试目标');
      expect(result.witem.status).toBe('active');
      expect(result.witem.horizon).toBe('short');
      expect(result.witem.priority).toBe('high');
      expect(result.witem.success_criteria).toEqual(['标准1']);
      expect(result.event.event_type).toBe('witem.defined');
      expect(result.edges_created).toHaveLength(0);
    });

    it('应该创建父子关系', async () => {
      const parent = await defineWitem(ctx, { title: '父目标', horizon: 'long', priority: 'high' });
      const child = await defineWitem(ctx, {
        title: '子目标', horizon: 'short', priority: 'medium',
        parent_witem: parent.witem.id,
      });

      expect(child.edges_created).toHaveLength(1);
      expect(child.edges_created[0].relation).toBe('decomposes_into');
      expect(child.edges_created[0].source_id).toBe(parent.witem.id);
    });
  });

  describe('decomposeWitem', () => {
    it('应该分解目标为子目标', async () => {
      const goal = await defineWitem(ctx, { title: '大目标', horizon: 'long', priority: 'high' });
      const result = await decomposeWitem(ctx, {
        witem_id: goal.witem.id,
        sub_witems: [{ title: '子目标A', horizon: 'medium' }],
      });

      expect(result.sub_witems_created).toHaveLength(1);
      expect(result.edges_created).toHaveLength(1);
      expect(result.event.event_type).toBe('witem.decomposed');
    });

    it('应该拒绝不存在的工作项', async () => {
      await expect(decomposeWitem(ctx, { witem_id: 'nonexistent' }))
        .rejects.toThrow('工作项不存在：nonexistent');
    });
  });

  describe('updateWitemStatus', () => {
    it('应该更新目标状态', async () => {
      const goal = await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'medium' });
      const result = await updateWitemStatus(ctx, {
        witem_id: goal.witem.id,
        new_status: 'achieved',
        reason: '已完成',
      });

      expect(result.witem.status).toBe('achieved');
      expect(result.event.event_type).toBe('witem.status_changed');
    });

    it('应该拒绝无效的状态转换', async () => {
      const goal = await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'medium' });
      await updateWitemStatus(ctx, { witem_id: goal.witem.id, new_status: 'achieved', reason: '完成' });
      await expect(updateWitemStatus(ctx, {
        witem_id: goal.witem.id, new_status: 'active', reason: '回退',
      })).rejects.toThrow('无效状态迁移：achieved → active');
    });
  });

  // ============================================================
  // Decision Operations
  // ============================================================

  describe('recordDecision', () => {
    it('应该记录决策并创建关联风险和技术债', async () => {
      const anchor = await defineWitem(ctx, { title: '锚', horizon: 'short', priority: 'medium' });
      const result = await recordDecision(ctx, {
        title: '选择 TypeScript',
        context: '需要选语言',
        rationale: 'MCP SDK 官方语言',
        risks_created: [{
          title: '绑定 Node.js',
          description: '无法脱离 Node',
          likelihood: 'high',
          impact: 'low',
        }],
        tech_debt_created: [{
          title: '缺少测试',
          description: 'MVP 阶段跳过测试',
          severity: 'medium',
          affected_area: '全局',
          cost_of_delay: '后续难维护',
        }],
        related_witems: [anchor.witem.id],
      });

      expect(result.decision.title).toBe('选择 TypeScript');
      expect(result.risks_created).toHaveLength(1);
      expect(result.tech_debt_created).toHaveLength(1);
      expect(result.edges_created.length).toBeGreaterThanOrEqual(2);
    });

    it('应该支持取代旧决策', async () => {
      const anchor = await defineWitem(ctx, { title: '锚', horizon: 'short', priority: 'medium' });
      const old = await recordDecision(ctx, { title: '旧决策', context: 'ctx', rationale: 'r', related_witems: [anchor.witem.id] });
      const result = await recordDecision(ctx, {
        title: '新决策', context: 'ctx', rationale: 'r',
        supersedes: old.decision.id,
      });

      const oldNode = await ctx.nodes.getById(old.decision.id);
      expect(oldNode!.status).toBe('superseded');
      expect(result.edges_created.some(e => e.relation === 'supersedes')).toBe(true);
    });
  });

  describe('updateDecisionStatus', () => {
    it('应该支持兑现度回写：撤销/证伪置 failed', async () => {
      const anchor = await defineWitem(ctx, { title: '锚', horizon: 'short', priority: 'medium' });
      const decision = await recordDecision(ctx, { title: '决策', context: 'ctx', rationale: 'r', related_witems: [anchor.witem.id] });
      const result = await updateDecisionStatus(ctx, {
        decision_id: decision.decision.id,
        new_status: 'failed',
        reason: '预期被现实证伪',
      });

      expect(result.decision.status).toBe('failed');
      expect(result.event.event_type).toBe('decision.superseded');
      expect(result.event.diff).toEqual([{ field: 'status', old_value: 'accepted', new_value: 'failed' }]);
    });

    it('应该拒绝无效状态迁移', async () => {
      const anchor = await defineWitem(ctx, { title: '锚', horizon: 'short', priority: 'medium' });
      const decision = await recordDecision(ctx, { title: '决策', context: 'ctx', rationale: 'r', related_witems: [anchor.witem.id] });
      await updateDecisionStatus(ctx, { decision_id: decision.decision.id, new_status: 'failed', reason: '证伪' });
      await expect(updateDecisionStatus(ctx, {
        decision_id: decision.decision.id, new_status: 'accepted', reason: '复活',
      })).rejects.toThrow('无效状态迁移：failed → accepted');
    });
  });

  // ============================================================
  // Risk & Tech Debt Operations
  // ============================================================

  describe('identifyRisk', () => {
    it('应该识别风险并关联目标', async () => {
      const goal = await defineWitem(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const result = await identifyRisk(ctx, {
        title: '风险',
        description: '可能出问题',
        likelihood: 'medium',
        impact: 'high',
        affected_witems: [goal.witem.id],
      });

      expect(result.risk.status).toBe('identified');
      expect(result.edges_created).toHaveLength(1);
      expect(result.edges_created[0].relation).toBe('blocks');
    });
  });

  describe('updateRisk', () => {
    it('应该更新风险状态和属性', async () => {
      const risk = await identifyRisk(ctx, {
        title: '风险', description: '问题', likelihood: 'low', impact: 'medium',
      });
      const result = await updateRisk(ctx, {
        risk_id: risk.risk.id,
        new_status: 'analyzing',
        likelihood: 'high',
        reason: '重新评估',
      });

      expect(result.risk.status).toBe('analyzing');
      expect(result.risk.likelihood).toBe('high');
    });
  });

  describe('registerTechDebt', () => {
    it('应该注册技术债', async () => {
      const result = await registerTechDebt(ctx, {
        title: '缺少测试',
        description: '没有单元测试',
        severity: 'high',
        affected_area: 'operations',
        cost_of_delay: '质量下降',
      });

      expect(result.tech_debt.status).toBe('identified');
      expect(result.tech_debt.severity).toBe('high');
    });
  });

  // ============================================================
  // Knowledge Operations
  // ============================================================

  describe('recordKnowledge', () => {
    it('应该记录知识', async () => {
      const result = await recordKnowledge(ctx, {
        title: 'SQLite WAL 模式',
        description: 'WAL 模式提高并发读性能',
        domain: 'database',
        source: '官方文档',
      });

      expect(result.knowledge.title).toBe('SQLite WAL 模式');
      expect(result.knowledge.domain).toBe('database');
      expect(result.knowledge.confidence).toBe('medium');
    });

    it('应该支持取代旧知识', async () => {
      const old = await recordKnowledge(ctx, {
        title: '旧知识', description: '内容', domain: 'test', source: 'src',
      });
      const result = await recordKnowledge(ctx, {
        title: '新知识', description: '内容', domain: 'test', source: 'src',
        invalidates: [old.knowledge.id],
      });

      expect(result.invalidated_nodes).toHaveLength(1);
      expect(result.invalidated_nodes[0].status).toBe('outdated');
      const oldNode = await ctx.nodes.getById(old.knowledge.id);
      expect(oldNode!.status).toBe('outdated');
    });
  });

  // ============================================================
  // Graph Operations
  // ============================================================

  describe('linkNodes', () => {
    it('应该在合法节点间创建边', async () => {
      const parent = await defineWitem(ctx, { title: '父', horizon: 'short', priority: 'high' });
      const child = await defineWitem(ctx, { title: '子', horizon: 'short', priority: 'medium' });
      const result = await linkNodes(ctx, {
        source_id: parent.witem.id,
        target_id: child.witem.id,
        relation: 'decomposes_into',
      });

      expect(result.edge.relation).toBe('decomposes_into');
    });

    it('应该拒绝非法关系', async () => {
      const w1 = await defineWitem(ctx, { title: '工作项1', horizon: 'short', priority: 'medium' });
      const w2 = await defineWitem(ctx, { title: '工作项2', horizon: 'short', priority: 'medium' });
      await expect(linkNodes(ctx, {
        source_id: w1.witem.id,
        target_id: w2.witem.id,
        relation: 'fulfills',
      })).rejects.toThrow('无效关系「fulfills」：witem → witem');
    });
  });

  describe('getProjectState', () => {
    it('应该返回项目状态快照', async () => {
      await defineWitem(ctx, { title: '活跃工作项', horizon: 'short', priority: 'high' });
      await identifyRisk(ctx, {
        title: '风险', description: '描述', likelihood: 'high', impact: 'critical',
      });

      const state = await getProjectState(ctx);
      expect(state.active_witems).toHaveLength(1);
      expect(state.open_risks).toHaveLength(1);
      expect(state.statistics.total_witems).toBe(1);
    });
  });

  describe('getNodeContext', () => {
    it('应该返回节点及其关联信息', async () => {
      const parent = await defineWitem(ctx, { title: '父', horizon: 'short', priority: 'high' });
      const child = await defineWitem(ctx, { title: '子', horizon: 'short', priority: 'medium', parent_witem: parent.witem.id });

      const context = await getNodeContext(ctx, parent.witem.id);
      expect(context.node.id).toBe(parent.witem.id);
      expect(context.edges).toHaveLength(1);
      expect(context.neighbors).toHaveLength(1);
      expect(context.events.length).toBeGreaterThan(0);
    });

    it('应该抛出节点不存在错误', async () => {
      await expect(getNodeContext(ctx, 'nonexistent')).rejects.toThrow('节点不存在：nonexistent');
    });
  });

  describe('updateRequirementStatus', () => {
    it('satisfied 可转 deprecated（满足但键已移出 BOM 的旧节点清理路径）', async () => {
      const { requirement } = await defineRequirement(ctx, {
        title: '旧域需求', source: 'vibespec', source_detail: 'old-domain/ghost',
      });
      await updateRequirementStatus(ctx, { requirement_id: requirement.id, new_status: 'accepted', reason: '受理' });
      await updateRequirementStatus(ctx, { requirement_id: requirement.id, new_status: 'in_execution', reason: '开工' });
      await updateRequirementStatus(ctx, { requirement_id: requirement.id, new_status: 'satisfied', reason: '已达成' });
      const { requirement: updated } = await updateRequirementStatus(ctx, {
        requirement_id: requirement.id, new_status: 'deprecated', reason: 'BOM 键已消失',
      });
      expect(updated.status).toBe('deprecated');
    });

    it('deprecated 不可重复废弃', async () => {
      const { requirement } = await defineRequirement(ctx, {
        title: '需求', source: 'vibespec', source_detail: 'dom/req',
      });
      await updateRequirementStatus(ctx, {
        requirement_id: requirement.id, new_status: 'deprecated', reason: '移除',
      });
      await expect(updateRequirementStatus(ctx, {
        requirement_id: requirement.id, new_status: 'deprecated', reason: '重复',
      })).rejects.toThrow(/无效状态迁移/);
    });
  });
});
