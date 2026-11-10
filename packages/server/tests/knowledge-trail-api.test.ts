import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../core/tests/helpers/test-db.js';
import { OperationContext, recordKnowledge, defineWitem } from '@sibeaver/core';
import type { Sql } from '@sibeaver/core';
import { createHonoApp } from '../src/api/server.js';
import type { ProjectManager } from '../src/projects/manager.js';

describe('knowledge-trail REST', () => {
  let sql: Sql;
  let close: () => void;
  let ctx: OperationContext;
  let app: ReturnType<typeof createHonoApp>;

  beforeEach(async () => {
    const db = await createTestDb();
    sql = db.sql;
    close = db.close;
    ctx = new OperationContext(db.sql, 'default');
    app = createHonoApp({ getContext: () => ctx } as unknown as ProjectManager);
  });

  afterEach(async () => { await close(); });

  it('返回知识链并标记 outdated', async () => {
    const oldKnowledge = await recordKnowledge(ctx, {
      title: '旧', description: 'd', domain: 'db', source: 's',
    });
    const newKnowledge = await recordKnowledge(ctx, {
      title: '新', description: 'd', domain: 'db', source: 's',
      invalidates: [oldKnowledge.knowledge.id],
    });

    const res = await app.request(
      `/default/api/v1/nodes/${newKnowledge.knowledge.id}/knowledge-trail?max_depth=1`,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as {
      root: { id: string };
      trail: Array<{ node: { id: string; status: string } }>;
    };
    expect(data.root.id).toBe(newKnowledge.knowledge.id);
    expect(data.trail[0].node.id).toBe(oldKnowledge.knowledge.id);
    expect(data.trail[0].node.status).toBe('outdated');
  });

  it('空 relations 走默认关系集', async () => {
    const oldKnowledge = await recordKnowledge(ctx, {
      title: '旧', description: 'd', domain: 'db', source: 's',
    });
    const newKnowledge = await recordKnowledge(ctx, {
      title: '新', description: 'd', domain: 'db', source: 's',
      invalidates: [oldKnowledge.knowledge.id],
    });

    const res = await app.request(
      `/default/api/v1/nodes/${newKnowledge.knowledge.id}/knowledge-trail?relations=`,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { trail: Array<{ node: { id: string } }> };
    expect(data.trail.some(t => t.node.id === oldKnowledge.knowledge.id)).toBe(true);
  });

  it('非法参数与非 knowledge 起点返回 400，缺失节点返回 404', async () => {
    const knowledge = await recordKnowledge(ctx, {
      title: 'K', description: 'd', domain: 'db', source: 's',
    });
    const witem = await defineWitem(ctx, {
      title: 'W', horizon: 'short', priority: 'medium',
    });

    expect((await app.request(
      `/default/api/v1/nodes/${knowledge.knowledge.id}/knowledge-trail?max_depth=11`,
    )).status).toBe(400);
    expect((await app.request(
      `/default/api/v1/nodes/${knowledge.knowledge.id}/knowledge-trail?relations=bogus`,
    )).status).toBe(400);
    expect((await app.request(
      `/default/api/v1/nodes/${witem.witem.id}/knowledge-trail`,
    )).status).toBe(400);
    expect((await app.request(
      '/default/api/v1/nodes/nonexistent/knowledge-trail',
    )).status).toBe(404);
  });
});
