import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../core/tests/helpers/test-db.js';
import { OperationContext, ExecutorProfileInput } from '@sibeaver/core';
import { listExecutors, registerExecutor } from '../src/executor/engine.js';

const BASE = {
  executor: 'qoder-agent',
  harness: 'qoder',
  models: ['sonnet', 'gpt'],
  concurrency: 2,
  isolation_modes: ['worktree'] as const,
  writable_scopes: ['vibesrcs/'],
};

describe('执行者画像', () => {
  let ctx: OperationContext;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    ctx = new OperationContext(t.sql, 'default');
    close = t.close;
  });

  afterEach(async () => { await close(); });

  it('注册后可按名称查询与列出', async () => {
    const profile = await registerExecutor(ctx, { ...BASE, isolation_modes: [...BASE.isolation_modes] });
    expect(profile.executor).toBe('qoder-agent');
    expect(profile.created_at).toBe(profile.updated_at);
    expect(await ctx.executors.get('qoder-agent')).toEqual(profile);
    expect(await listExecutors(ctx)).toEqual([profile]);
  });

  it('同名重复注册更新能力并保留 createdAt', async () => {
    const first = await registerExecutor(ctx, { ...BASE, isolation_modes: [...BASE.isolation_modes] });
    const second = await registerExecutor(ctx, {
      ...BASE,
      models: ['m2'],
      concurrency: 3,
      isolation_modes: ['worktree', 'workspace'],
      writable_scopes: [],
    });
    expect(second.created_at).toBe(first.created_at);
    expect(second.models).toEqual(['m2']);
    expect(second.concurrency).toBe(3);
    expect(second.isolation_modes).toEqual(['worktree', 'workspace']);
    expect(second.writable_scopes).toEqual([]);
    expect(await listExecutors(ctx)).toHaveLength(1);
  });

  it('画像输入机械校验：空隔离方式与并发度 < 1 被拒绝', () => {
    expect(ExecutorProfileInput.safeParse({ ...BASE, isolation_modes: [] }).success).toBe(false);
    expect(ExecutorProfileInput.safeParse({ ...BASE, concurrency: 0 }).success).toBe(false);
    expect(ExecutorProfileInput.safeParse({ ...BASE, executor: '' }).success).toBe(false);
  });
});
