import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OperationContext } from '@sibeaver/core';
import { toApiEvent } from '../src/api/transforms.js';
import { createTestDb } from '../../core/tests/helpers/test-db.js';

// 事件归一化回归：eventStore 返回 snake_case EventRecord，API/poller 消费 camelCase ApiEvent。
// 曾因漏归一化导致 direct 模式下 requirement.status_changed / knowledge.recorded 管线静默失效。

describe('事件归一化 toApiEvent', () => {
  let ctx: OperationContext;
  let close: () => void;

  beforeEach(async () => {
    const db = await createTestDb();
    ctx = new OperationContext(db.sql, 'default');
    close = db.close;
  });

  afterEach(() => close());

  it('把 snake_case EventRecord 映射为 camelCase ApiEvent', async () => {
    const recorded = await ctx.events.emit({
      event_type: 'knowledge.recorded',
      operation: 'record_knowledge',
      node_id: 'node-1',
      node_type: 'knowledge',
      payload: { title: 't' },
    });

    const rows = await ctx.eventStore.getSince(recorded.timestamp);
    expect(rows.length).toBeGreaterThan(0);

    const apiEvents = rows.map(toApiEvent);
    const ev = apiEvents.find(e => e.id === recorded.id)!;
    expect(ev.eventType).toBe('knowledge.recorded');
    expect(ev.nodeId).toBe('node-1');
    expect(ev.nodeType).toBe('knowledge');
    expect(ev.payload).toEqual({ title: 't' });
    // 不得残留 snake_case 字段（poller 按 eventType/nodeId 查 handler）
    expect(ev).not.toHaveProperty('event_type');
    expect(ev).not.toHaveProperty('node_id');
  });
});
