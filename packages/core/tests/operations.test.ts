import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestSql } from './helpers/test-db.js';
import type { Sql } from '../src/storage/db.js';
import { OperationContext } from '../src/operations/context.js';
import {
  defineGoal, decomposeGoal, updateGoalStatus,
  beginExploration, recordExplorationFinding, concludeExploration, abandonExploration,
  recordDecision,
  identifyRisk, updateRisk, registerTechDebt,
  recordKnowledge,
  createTask,
  linkNodes, getProjectState, getNodeContext,
} from '../src/operations/index.js';

describe('Operations Layer', () => {
  let sql: Sql;
  let close: () => void;
  let ctx: OperationContext;

  beforeEach(() => {
    const test = createTestSql();
    sql = test.sql;
    close = test.close;
    ctx = new OperationContext(sql, 'default');
  });

  afterEach(() => {
    close();
  });

  // ============================================================
  // Goal Operations
  // ============================================================

  describe('defineGoal', () => {
    it('应该创建目标并返回事件', async () => {
      const result = await defineGoal(ctx, {
        title: '测试目标',
        horizon: 'short',
        priority: 'high',
        success_criteria: ['标准1'],
        tags: ['test'],
      });

      expect(result.goal.title).toBe('测试目标');
      expect(result.goal.status).toBe('active');
      expect(result.goal.horizon).toBe('short');
      expect(result.goal.priority).toBe('high');
      expect(result.goal.success_criteria).toEqual(['标准1']);
      expect(result.event.event_type).toBe('goal.defined');
      expect(result.edges_created).toHaveLength(0);
    });

    it('应该创建父子关系', async () => {
      const parent = await defineGoal(ctx, { title: '父目标', horizon: 'long', priority: 'high' });
      const child = await defineGoal(ctx, {
        title: '子目标', horizon: 'short', priority: 'medium',
        parent_goal: parent.goal.id,
      });

      expect(child.edges_created).toHaveLength(1);
      expect(child.edges_created[0].relation).toBe('decomposes_into');
      expect(child.edges_created[0].source_id).toBe(parent.goal.id);
    });
  });

  describe('decomposeGoal', () => {
    it('应该分解目标为子目标、任务和探索', async () => {
      const goal = await defineGoal(ctx, { title: '大目标', horizon: 'long', priority: 'high' });
      const result = await decomposeGoal(ctx, {
        goal_id: goal.goal.id,
        sub_goals: [{ title: '子目标A', horizon: 'medium' }],
        explorations_needed: [{ topic: '探索X', reason: '需要调研' }],
      });

      expect(result.sub_goals_created).toHaveLength(1);
      expect(result.explorations_created).toHaveLength(1);
      expect(result.edges_created).toHaveLength(2);
      expect(result.event.event_type).toBe('goal.decomposed');
    });

    it('应该拒绝不存在的目标', async () => {
      await expect(decomposeGoal(ctx, { goal_id: 'nonexistent' }))
        .rejects.toThrow('目标不存在：nonexistent');
    });
  });

  describe('updateGoalStatus', () => {
    it('应该更新目标状态', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'medium' });
      const result = await updateGoalStatus(ctx, {
        goal_id: goal.goal.id,
        new_status: 'achieved',
        reason: '已完成',
      });

      expect(result.goal.status).toBe('achieved');
      expect(result.event.event_type).toBe('goal.status_changed');
    });

    it('应该拒绝无效的状态转换', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'medium' });
      await updateGoalStatus(ctx, { goal_id: goal.goal.id, new_status: 'achieved', reason: '完成' });
      await expect(updateGoalStatus(ctx, {
        goal_id: goal.goal.id, new_status: 'active', reason: '回退',
      })).rejects.toThrow('无效状态迁移：achieved → active');
    });
  });

  // ============================================================
  // Exploration Operations
  // ============================================================

  describe('beginExploration', () => {
    it('应该创建探索并关联目标', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const result = await beginExploration(ctx, {
        topic: '研究问题',
        reason: '需要了解',
        related_goals: [goal.goal.id],
      });

      expect(result.exploration.title).toBe('研究问题');
      expect(result.exploration.status).toBe('active');
      expect(result.edges_created).toHaveLength(1);
      expect(result.edges_created[0].relation).toBe('spawns');
    });
  });

  describe('recordExplorationFinding', () => {
    it('应该记录发现并追加到 findings', async () => {
      const exp = await beginExploration(ctx, { topic: '探索', reason: '原因' });
      const result = await recordExplorationFinding(ctx, {
        exploration_id: exp.exploration.id,
        finding: '发现了重要信息',
        significance: 'major',
      });

      expect(result.exploration.findings).toContain('发现了重要信息');
      expect(result.event.event_type).toBe('exploration.finding_recorded');
    });

    it('应该拒绝非活跃探索', async () => {
      const exp = await beginExploration(ctx, { topic: '探索', reason: '原因' });
      await concludeExploration(ctx, {
        exploration_id: exp.exploration.id,
        conclusion: '结论',
        outcome: 'validated',
      });
      await expect(recordExplorationFinding(ctx, {
        exploration_id: exp.exploration.id,
        finding: '迟到的发现',
        significance: 'minor',
      })).rejects.toThrow('探索不在活跃状态：concluded');
    });
  });

  describe('concludeExploration', () => {
    it('应该结论化探索并创建衍生节点', async () => {
      const exp = await beginExploration(ctx, { topic: '探索', reason: '原因' });
      const result = await concludeExploration(ctx, {
        exploration_id: exp.exploration.id,
        conclusion: '结论',
        outcome: 'validated',
        decisions: [{ title: '决策A', rationale: '原因' }],
        knowledge: [{ title: '知识B', domain: 'test', description: '内容' }],
      });

      expect(result.exploration.status).toBe('concluded');
      expect(result.decisions_created).toHaveLength(1);
      expect(result.knowledge_created).toHaveLength(1);
      expect(result.edges_created.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('abandonExploration', () => {
    it('应该放弃探索并可选记录学习', async () => {
      const exp = await beginExploration(ctx, { topic: '探索', reason: '原因' });
      const result = await abandonExploration(ctx, {
        exploration_id: exp.exploration.id,
        reason: '方向错误',
        learnings: '学到了不该走这条路',
      });

      expect(result.exploration.status).toBe('abandoned');
      expect(result.knowledge_created).not.toBeNull();
      expect(result.knowledge_created!.title).toContain('从失败探索中学到');
    });
  });

  // ============================================================
  // Decision Operations
  // ============================================================

  describe('recordDecision', () => {
    it('应该记录决策并创建关联风险和技术债', async () => {
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
      });

      expect(result.decision.title).toBe('选择 TypeScript');
      expect(result.risks_created).toHaveLength(1);
      expect(result.tech_debt_created).toHaveLength(1);
      expect(result.edges_created.length).toBeGreaterThanOrEqual(2);
    });

    it('应该支持取代旧决策', async () => {
      const old = await recordDecision(ctx, { title: '旧决策', context: 'ctx', rationale: 'r' });
      const result = await recordDecision(ctx, {
        title: '新决策', context: 'ctx', rationale: 'r',
        supersedes: old.decision.id,
      });

      const oldNode = await ctx.nodes.getById(old.decision.id);
      expect(oldNode!.status).toBe('superseded');
      expect(result.edges_created.some(e => e.relation === 'supersedes')).toBe(true);
    });
  });

  // ============================================================
  // Risk & Tech Debt Operations
  // ============================================================

  describe('identifyRisk', () => {
    it('应该识别风险并关联目标', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const result = await identifyRisk(ctx, {
        title: '风险',
        description: '可能出问题',
        likelihood: 'medium',
        impact: 'high',
        affected_goals: [goal.goal.id],
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
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      const task = await createTask(ctx, { title: '任务' });
      const result = await linkNodes(ctx, {
        source_id: goal.goal.id,
        target_id: task.task.id,
        relation: 'decomposes_into',
      });

      expect(result.edge.relation).toBe('decomposes_into');
    });

    it('应该拒绝非法关系', async () => {
      const task1 = await createTask(ctx, { title: '任务1' });
      const task2 = await createTask(ctx, { title: '任务2' });
      await expect(linkNodes(ctx, {
        source_id: task1.task.id,
        target_id: task2.task.id,
        relation: 'decomposes_into',
      })).rejects.toThrow('无效关系「decomposes_into」：task → task');
    });
  });

  describe('getProjectState', () => {
    it('应该返回项目状态快照', async () => {
      await defineGoal(ctx, { title: '活跃目标', horizon: 'short', priority: 'high' });
      await beginExploration(ctx, { topic: '活跃探索', reason: '原因' });
      await identifyRisk(ctx, {
        title: '风险', description: '描述', likelihood: 'high', impact: 'critical',
      });

      const state = await getProjectState(ctx);
      expect(state.active_goals).toHaveLength(1);
      expect(state.active_explorations).toHaveLength(1);
      expect(state.open_risks).toHaveLength(1);
      expect(state.statistics.total_goals).toBe(1);
    });
  });

  describe('getNodeContext', () => {
    it('应该返回节点及其关联信息', async () => {
      const goal = await defineGoal(ctx, { title: '目标', horizon: 'short', priority: 'high' });
      await createTask(ctx, { title: '任务', parent_goal: goal.goal.id });

      const context = await getNodeContext(ctx, goal.goal.id);
      expect(context.node.id).toBe(goal.goal.id);
      expect(context.edges).toHaveLength(1);
      expect(context.neighbors).toHaveLength(1);
      expect(context.events.length).toBeGreaterThan(0);
    });

    it('应该抛出节点不存在错误', async () => {
      await expect(getNodeContext(ctx, 'nonexistent')).rejects.toThrow('节点不存在：nonexistent');
    });
  });
});
