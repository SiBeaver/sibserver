import type { ExecutorProfile, ExecutorProfileInput, OperationContext } from '@sibeaver/core';

// ============================================================
// 执行者画像 — 声明性能力记录（不做分派、不路由模型）
// ============================================================

// @sibom r-ea3c — 执行者以画像声明自身能力：harness、模型、并发度、隔离方式与可写范围；分派匹配归 harness
// @sibom r-ea4d — 模型选择属于执行者与 harness；控制面只记录画像与证据来源，不路由模型调用
export async function registerExecutor(
  ctx: OperationContext,
  input: ExecutorProfileInput,
): Promise<ExecutorProfile> {
  const now = new Date().toISOString();
  const existing = await ctx.executors.get(input.executor);
  return ctx.executors.upsert({
    executor: input.executor,
    harness: input.harness,
    models: [...new Set(input.models)],
    concurrency: input.concurrency,
    isolation_modes: [...new Set(input.isolation_modes)],
    writable_scopes: [...new Set(input.writable_scopes)],
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
}

export async function listExecutors(ctx: OperationContext): Promise<ExecutorProfile[]> {
  return ctx.executors.list();
}
