import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OperationContext } from '@sibeaver/core';
import { registerTools, slimEnvelope, slimSearchResult, slimBatchResult, slimProjectStateResult } from '../src/mcp/tools.js';
import { createTestDb } from '../../core/tests/helpers/test-db.js';

// MCP 响应瘦身：写操作只回执确认字段，搜索截断 description
//（每次 MCP 调用都进 agent 上下文，全量回显是 token 浪费源）

function captureHandlers(ctx: OperationContext): Record<string, (args: any) => Promise<unknown>> {
  const registrations: Record<string, (args: any) => Promise<unknown>> = {};
  const fakeServer: any = {
    tool: (...args: unknown[]) => {
      registrations[String(args[0])] = args[args.length - 1] as (a: any) => Promise<unknown>;
    },
  };
  registerTools(fakeServer, { mode: 'scoped', getContext: () => ctx, slug: 'smoke', getMetadata: () => ({}) });
  return registrations;
}

describe('MCP 响应瘦身', () => {
  let ctx: OperationContext;
  let handlers: Record<string, (args: any) => Promise<unknown>>;
  let close: () => void;

  beforeEach(async () => {
    const db = await createTestDb();
    ctx = new OperationContext(db.sql, 'default');
    close = db.close;
    handlers = captureHandlers(ctx);
  });

  it('record_decision 只回执确认字段（无 context/rationale/consequences 全量）', async () => {
    const res = await handlers['record_decision']({
      title: 't', context: 'ctx', rationale: 'rat',
      consequences: ['c1', 'c2'],
      alternatives_considered: [{ option: 'a', reason_rejected: 'r' }],
      risks_created: [{ title: 'r1', description: 'd', likelihood: 'medium', impact: 'high' }],
    }) as { content: Array<{ text: string }> };
    const data = JSON.parse(res.content[0].text);
    expect(data.decision).toEqual({
      id: expect.any(String), type: 'decision', title: 't', status: 'accepted',
    });
    expect(data.risksCreated[0]).toEqual({
      id: expect.any(String), type: 'risk', title: 'r1', status: 'identified',
    });
    expect(data.techDebtCreated).toEqual([]);
    expect(data.event).toHaveProperty('id');
    expect(data.event).toHaveProperty('eventType');
    expect(data.event).not.toHaveProperty('payload');
  });

  it('link_nodes 只回执边确认字段', async () => {
    await ctx.nodes.insert({
      id: 'a', type: 'knowledge', title: 'A', description: '', status: 'established',
      tags: [], created_at: '', updated_at: '', metadata: {},
    });
    const res = await handlers['link_nodes']({ source_id: 'a', target_id: 'a', relation: 'relates_to' }) as { content: Array<{ text: string }> };
    const data = JSON.parse(res.content[0].text);
    expect(data.edge).toEqual({
      id: expect.any(String), sourceId: 'a', targetId: 'a', relation: 'relates_to',
    });
  });

  it('slimEnvelope 保留标量，投影节点/边/事件（camelCase 输出）', () => {
    const out = slimEnvelope({
      goal: { id: 'g1', type: 'goal', title: 'G', status: 'active', success_criteria: ['x'] },
      edges_created: [{ id: 'e1', source_id: 'g1', target_id: 'g2', relation: 'blocks' }],
      event: { id: 'ev1', event_type: 'goal.created', payload: { big: 'data' } },
    } as any);
    expect(out).toEqual({
      goal: { id: 'g1', type: 'goal', title: 'G', status: 'active' },
      edges_created: [{ id: 'e1', sourceId: 'g1', targetId: 'g2', relation: 'blocks' }],
      event: { id: 'ev1', eventType: 'goal.created' },
    });
  });

  it('slimSearchResult 截断长 description、保留挑选字段', () => {
    const long = '字'.repeat(500);
    const out = slimSearchResult({
      query: 'x', count: 1,
      results: [{ id: 'k1', type: 'knowledge', title: 'K', description: long, domain: 'd', confidence: 'high', scope: 'project', metadata: { huge: true }, content: 'x'.repeat(1000) }],
    } as any);
    expect(out.results[0]).toEqual({
      id: 'k1', type: 'knowledge', title: 'K', domain: 'd', confidence: 'high', scope: 'project',
      description: expect.stringMatching(/^字{200}…$/),
    });
    expect(out.results[0]).not.toHaveProperty('content');
    expect(out.results[0]).not.toHaveProperty('metadata');
    expect(out.count).toBe(1);
    expect(out.query).toBe('x');
  });

  it('slimSearchResult 处理裸数组', () => {
    const out = slimSearchResult([{ id: 'a', type: 'task', title: 'T', description: '短' }] as any);
    expect(out[0]).toEqual({ id: 'a', type: 'task', title: 'T', description: '短' });
  });

  it('slimBatchResult 保留 summary，瘦身每条 result 信封', () => {
    const out = slimBatchResult({
      summary: { total: 1, succeeded: 1, failed: 0 },
      results: [{ op: 'create_task', ok: true, result: { task: { id: 't1', type: 'task', title: 'T', description: 'x' }, event: { id: 'e1', event_type: 'task.created' } } }],
    } as any);
    expect(out.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(out.results[0].result.task).toEqual({ id: 't1', type: 'task', title: 'T' });
    expect(out.results[0].op).toBe('create_task');
  });

  it('slimProjectStateResult 截断 description、去 content、findings 只留 3 条、去重复 requirements', () => {
    const long = '字'.repeat(500);
    const res = slimProjectStateResult({
      content: [{ type: 'text', text: JSON.stringify({
        active_goals: [{ id: 'g1', type: 'goal', title: 'G', status: 'active', description: long, content: 'x'.repeat(1000), success_criteria: ['a', 'b'] }],
        active_explorations: [{ id: 'e1', type: 'exploration', title: 'E', status: 'active', description: 'd', hypothesis: long, findings: Array.from({ length: 5 }, (_, i) => `f${i}${'字'.repeat(300)}`) }],
        requirements: [{ id: 'r1', type: 'requirement', title: 'R', status: 'accepted', description: 'req' }],
        open_requirements: [{ id: 'r1', type: 'requirement', title: 'R', status: 'accepted', description: 'req' }],
        statistics: { total_requirements: 1 },
      }) }],
    } as any);
    const data = JSON.parse(res.content[0].text);
    expect(data.activeGoals[0]).toEqual({
      id: 'g1', type: 'goal', title: 'G', status: 'active',
      description: expect.stringMatching(/^字{200}…$/),
    });
    expect(data.activeGoals[0]).not.toHaveProperty('content');
    expect(data.activeGoals[0]).not.toHaveProperty('successCriteria');
    expect(data.activeExplorations[0].findings).toHaveLength(3);
    expect(data.activeExplorations[0].findings[0]).toMatch(/^f0字{198}…$/);
    expect(data).not.toHaveProperty('requirements');
    expect(data.openRequirements).toHaveLength(1);
    expect(data.statistics).toEqual({ totalRequirements: 1 });
  });

  afterEach(async () => { await close(); });
});
