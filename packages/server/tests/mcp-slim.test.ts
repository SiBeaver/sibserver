import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OperationContext } from '@sibeaver/core';
import type { Sql } from '@sibeaver/core';
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
    registerTool: (...args: unknown[]) => {
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
  let sql: Sql;

  beforeEach(async () => {
    const db = await createTestDb();
    sql = db.sql;
    ctx = new OperationContext(db.sql, 'default');
    close = db.close;
    handlers = captureHandlers(ctx);
  });

  it('record_decision 只回执确认字段（无 context/rationale/consequences 全量）', async () => {
    const anchor = await handlers['define_witem']({
      title: '锚', horizon: 'short', priority: 'medium',
    });
    const anchorId = JSON.parse(anchor.content[0].text).witem.id;
    const res = await handlers['record_decision']({
      title: 't', context: 'ctx', rationale: 'rat',
      consequences: ['c1', 'c2'],
      alternatives_considered: [{ option: 'a', reason_rejected: 'r' }],
      risks_created: [{ title: 'r1', description: 'd', likelihood: 'medium', impact: 'high' }],
      related_witems: [anchorId],
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
      witem: { id: 'g1', type: 'witem', title: 'G', status: 'active', success_criteria: ['x'] },
      edges_created: [{ id: 'e1', source_id: 'g1', target_id: 'g2', relation: 'blocks' }],
      event: { id: 'ev1', event_type: 'witem.defined', payload: { big: 'data' } },
    } as any);
    expect(out).toEqual({
      witem: { id: 'g1', type: 'witem', title: 'G', status: 'active' },
      edges_created: [{ id: 'e1', sourceId: 'g1', targetId: 'g2', relation: 'blocks' }],
      event: { id: 'ev1', eventType: 'witem.defined' },
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
    const out = slimSearchResult([{ id: 'a', type: 'witem', title: 'T', description: '短' }] as any);
    expect(out[0]).toEqual({ id: 'a', type: 'witem', title: 'T', description: '短' });
  });

  it('slimBatchResult 保留 summary，瘦身每条 result 信封', () => {
    const out = slimBatchResult({
      summary: { total: 1, succeeded: 1, failed: 0 },
      results: [{ op: 'define_witem', ok: true, result: { witem: { id: 't1', type: 'witem', title: 'T', description: 'x' }, event: { id: 'e1', event_type: 'witem.defined' } } }],
    } as any);
    expect(out.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(out.results[0].result.witem).toEqual({ id: 't1', type: 'witem', title: 'T' });
    expect(out.results[0].op).toBe('define_witem');
  });

  it('slimProjectStateResult 截断 description、去 content、去重复 requirements', () => {
    const long = '字'.repeat(500);
    const res = slimProjectStateResult({
      content: [{ type: 'text', text: JSON.stringify({
        active_witems: [{ id: 'g1', type: 'witem', title: 'G', status: 'active', description: long, content: 'x'.repeat(1000), success_criteria: ['a', 'b'] }],
        requirements: [{ id: 'r1', type: 'requirement', title: 'R', status: 'accepted', description: 'req' }],
        open_requirements: [{ id: 'r1', type: 'requirement', title: 'R', status: 'accepted', description: 'req' }],
        statistics: { total_requirements: 1 },
      }) }],
    } as any);
    const data = JSON.parse(res.content[0].text);
    expect(data.activeWitems[0]).toEqual({
      id: 'g1', type: 'witem', title: 'G', status: 'active',
      description: expect.stringMatching(/^字{200}…$/),
    });
    expect(data.activeWitems[0]).not.toHaveProperty('content');
    expect(data.activeWitems[0]).not.toHaveProperty('successCriteria');
    expect(data).not.toHaveProperty('requirements');
    expect(data.openRequirements).toHaveLength(1);
    expect(data.statistics).toEqual({ totalRequirements: 1 });
  });

  // MCP 协议服务 r-mp5e / r-mp6f：拒绝必须可自纠（回显判据），节点 ID 须完整 ULID 且不做前缀匹配。
  describe('拒绝自纠（r-mp5e / r-mp6f）', () => {
    async function defineW(title: string): Promise<string> {
      const res = await handlers['define_witem']({ title, horizon: 'short', priority: 'medium' });
      return JSON.parse(res.content[0].text).witem.id;
    }

    it('非法关系回显允许的源/目标节点类型集合', async () => {
      const a = await defineW('A');
      const b = await defineW('B');
      await expect(handlers['link_nodes']({
        source_id: a, target_id: b, relation: 'fulfills',
      })).rejects.toThrow(/无效关系「fulfills」：witem → witem；允许的源类型：\[witem\]，允许的目标类型：\[requirement\]/);
    });

    it('非法状态迁移回显当前状态与全部合法目标状态', async () => {
      const id = await defineW('W');
      await handlers['update_witem_status']({ witem_id: id, new_status: 'deferred', reason: '延后' });
      await expect(handlers['update_witem_status']({
        witem_id: id, new_status: 'achieved', reason: '跳过 active',
      })).rejects.toThrow(/无效状态迁移：deferred → achieved；当前状态 deferred，合法目标状态：\[active, abandoned\]/);
    });

    it('节点 ID 未命中回显传入值与所需形态', async () => {
      await expect(handlers['get_node_context']({ node_id: 'nonexistent' }))
        .rejects.toThrow(/节点不存在：nonexistent（节点 ID 须为 26 位完整 ULID，不接受缩写或前缀匹配）/);
    });

    it('缩写或前缀 ULID 不被前缀匹配', async () => {
      const id = await defineW('W');
      await expect(handlers['get_node_context']({ node_id: id.slice(0, 12) }))
        .rejects.toThrow(/不接受缩写或前缀匹配/);
    });

    it('合法完整 ULID 仍可定位', async () => {
      const id = await defineW('W');
      const res = await handlers['get_node_context']({ node_id: id });
      expect(JSON.parse(res.content[0].text).node.id).toBe(id);
    });

    it('26 位但字符集非法时提示 Crockford 形态', async () => {
      const badCharset = '01ARZ3NDEKTSV4RRFFQ69G5FAV'.slice(0, 25) + 'I';
      await expect(handlers['get_node_context']({ node_id: badCharset }))
        .rejects.toThrow(/Crockford Base32 ULID/);
    });

    it('拒绝不改变数据：非法关系不写入边', async () => {
      const a = await defineW('A');
      const b = await defineW('B');
      const before = (await sql`SELECT count(*)::int AS n FROM edges`)[0].n;
      await expect(handlers['link_nodes']({ source_id: a, target_id: b, relation: 'fulfills' }))
        .rejects.toThrow(/无效关系/);
      const after = (await sql`SELECT count(*)::int AS n FROM edges`)[0].n;
      expect(after).toBe(before);
    });

    it('拒绝不改变数据：非法迁移不改状态', async () => {
      const id = await defineW('W');
      await handlers['update_witem_status']({ witem_id: id, new_status: 'deferred', reason: '延后' });
      await expect(handlers['update_witem_status']({ witem_id: id, new_status: 'achieved', reason: '跳过' }))
        .rejects.toThrow(/无效状态迁移/);
      const res = await handlers['get_node_context']({ node_id: id });
      expect(JSON.parse(res.content[0].text).node.status).toBe('deferred');
    });

    it('record_decision 的关联工作项 ID 未命中时拒绝且不回写', async () => {
      const before = (await sql`SELECT count(*)::int AS n FROM nodes`)[0].n;
      await expect(handlers['record_decision']({
        title: 'd', context: 'c', rationale: 'r', related_witems: ['nonexistent'],
      })).rejects.toThrow(/关联工作项不存在：nonexistent（节点 ID 须为 26 位完整 ULID，不接受缩写或前缀匹配）/);
      const after = (await sql`SELECT count(*)::int AS n FROM nodes`)[0].n;
      expect(after).toBe(before);
    });

    it('record_decision 的 supersedes 未命中时拒绝且不回写', async () => {
      const before = (await sql`SELECT count(*)::int AS n FROM nodes`)[0].n;
      await expect(handlers['record_decision']({
        title: 'd', context: 'c', rationale: 'r', supersedes: 'nonexistent',
      })).rejects.toThrow(/被取代决策不存在：nonexistent/);
      const after = (await sql`SELECT count(*)::int AS n FROM nodes`)[0].n;
      expect(after).toBe(before);
    });

    it('identify_risk 的受影响工作项 ID 未命中时拒绝且不回写', async () => {
      const before = (await sql`SELECT count(*)::int AS n FROM nodes`)[0].n;
      await expect(handlers['identify_risk']({
        title: 'r', description: 'd', likelihood: 'high', impact: 'high',
        affected_witems: ['nonexistent'],
      })).rejects.toThrow(/受影响工作项不存在：nonexistent/);
      const after = (await sql`SELECT count(*)::int AS n FROM nodes`)[0].n;
      expect(after).toBe(before);
    });

    it('类型不符的关系拒绝回显关系允许的源/目标集合（derived_from）', async () => {
      const d = await handlers['record_decision']({ title: 'd', context: 'c', rationale: 'r' });
      const decisionId = JSON.parse(d.content[0].text).decision.id;
      await expect(handlers['record_knowledge']({
        title: 'k', description: 'desc', domain: 'd', source: 's', derived_from: [decisionId],
      })).rejects.toThrow(/允许的源类型：\[witem\]，允许的目标类型：\[knowledge\]/);
    });

    it('类型不符的关系拒绝回显关系允许的源/目标集合（creates）', async () => {
      const w = await defineW('W');
      await expect(handlers['register_tech_debt']({
        title: 't', description: 'd', severity: 'high', affected_area: 'a', cost_of_delay: 'c',
        caused_by: w,
      })).rejects.toThrow(/允许的源类型：\[decision\]，允许的目标类型：\[tech_debt, risk\]/);
    });

    it('record_knowledge 的 invalidates 未命中时拒绝且不回写', async () => {
      const before = (await sql`SELECT count(*)::int AS n FROM nodes`)[0].n;
      await expect(handlers['record_knowledge']({
        title: 'k', description: 'd', domain: 'x', source: 's', invalidates: ['nonexistent'],
      })).rejects.toThrow(/被取代知识不存在：nonexistent（节点 ID 须为 26 位完整 ULID，不接受缩写或前缀匹配）/);
      expect((await sql`SELECT count(*)::int AS n FROM nodes`)[0].n).toBe(before);
    });

    it('related_witems 拒绝非 witem 类型并回显参数判据', async () => {
      const d = await handlers['record_decision']({ title: 'd', context: 'c', rationale: 'r' });
      const decisionId = JSON.parse(d.content[0].text).decision.id;
      await expect(handlers['record_decision']({
        title: 'd2', context: 'c', rationale: 'r', related_witems: [decisionId],
      })).rejects.toThrow(/related_witems 只接受 witem 类型节点/);
    });

    it('get_claim 未命中回显 ID 与认领形态', async () => {
      await expect(handlers['get_claim']({ claim_id: 'nonexistent' }))
        .rejects.toThrow(/认领不存在：nonexistent（认领 ID 须为 26 位完整 ULID，不接受缩写或前缀匹配）/);
    });

    it('提案未命中回显 ID 与形态；已处理提案再确认回显当前状态', async () => {
      await expect(handlers['confirm_replan_proposal']({
        proposal_id: 'nonexistent', confirmed_by: 'me',
      })).rejects.toThrow(/提案不存在：nonexistent（提案 ID 须为 26 位完整 ULID，不接受缩写或前缀匹配）/);

      const p = await handlers['propose_replan']({ proposer: 'p', summary: 's' });
      const proposalId = JSON.parse(p.content[0].text).id;
      await handlers['confirm_replan_proposal']({ proposal_id: proposalId, confirmed_by: 'me' });
      await expect(handlers['confirm_replan_proposal']({
        proposal_id: proposalId, confirmed_by: 'me',
      })).rejects.toThrow(/无效状态迁移：confirmed → confirmed；当前状态 confirmed，合法目标状态：\[（无）\]/);
    });

    it('已完成根节点被过滤时不误报不存在', async () => {
      const id = await defineW('W');
      await handlers['update_witem_status']({ witem_id: id, new_status: 'achieved', reason: 'done' });
      const res = await handlers['get_roadmap']({ root_witem: id });
      expect(JSON.parse(res.content[0].text).roadmap).toEqual([]);
    });

    it('存在但类型不符时回显实际类型（不误报未命中）', async () => {
      const d = await handlers['record_decision']({ title: 'd', context: 'c', rationale: 'r' });
      const decisionId = JSON.parse(d.content[0].text).decision.id;
      await expect(handlers['update_witem_status']({
        witem_id: decisionId, new_status: 'achieved', reason: 'x',
      })).rejects.toThrow(/工作项类型不符：.* 是 decision；需要 witem 类型节点/);
    });

    it('invalidates 类型不符时回显参数判据', async () => {
      const w = await defineW('W');
      await expect(handlers['record_knowledge']({
        title: 'k', description: 'd', domain: 'x', source: 's', invalidates: [w],
      })).rejects.toThrow(/被取代知识类型不符：.* 是 witem；invalidates 只接受 knowledge 类型节点/);
    });
  });

  afterEach(async () => { await close(); });
});


function mcpResultText(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(item => item.text ?? '').join(' ');
}

// r-ar7g：提案只承载引用——MCP 传输层必须拒绝正文与未知字段，而非静默剥离
describe('MCP 提案工具严格拒绝正文', () => {
  let server: McpServer;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const db = await createTestDb();
    const ctx = new OperationContext(db.sql, 'default');
    server = new McpServer({ name: 'test', version: '0.0.0' });
    registerTools(server, { mode: 'scoped', getContext: () => ctx, slug: 'test', getMetadata: () => ({}) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
      await db.close();
    };
  });

  afterEach(async () => { await close(); });

  it('propose_replan 携带 detail 被拒绝', async () => {
    const res = await client.callTool({
      name: 'propose_replan',
      arguments: { proposer: 'p', summary: 's', detail: { heavy: 'x' } },
    });
    expect(res.isError).toBe(true);
    expect(mcpResultText(res)).toMatch(/detail/);
  });

  it('propose_replan 未知别名字段同样被拒绝', async () => {
    const res = await client.callTool({
      name: 'propose_replan',
      arguments: { proposer: 'p', summary: 's', body: 'text' },
    });
    expect(res.isError).toBe(true);
    expect(mcpResultText(res)).toMatch(/body/);
  });

  it('propose_contract_change 携带 detail 被拒绝', async () => {
    const res = await client.callTool({
      name: 'propose_contract_change',
      arguments: {
        workpack_id: 'wp',
        proposer: 'p',
        summary: 's',
        requirement_keys: ['dom/a'],
        refs: [{ path: 'vibespec/requirements/dom/a.md', commit: 'aa1' }],
        detail: {},
      },
    });
    expect(res.isError).toBe(true);
    expect(mcpResultText(res)).toMatch(/detail/);
  });

  it('不带正文的提案通过校验', async () => {
    const res = await client.callTool({
      name: 'propose_replan',
      arguments: { proposer: 'p', summary: 's' },
    });
    expect(res.isError).not.toBe(true);
  });
});
