import { z } from 'zod';
import { IsolationMode } from '../claims/types.js';

// ============================================================
// 执行者画像 — 执行面声明的能力（r-ea3c / r-ea4d）
// 纯记录：控制面不据此路由模型，也不替 harness 做分派匹配。
// ============================================================

export const ExecutorProfileInput = z.object({
  executor: z.string().min(1),
  harness: z.string().min(1),
  models: z.array(z.string()),
  concurrency: z.number().int().min(1),
  isolation_modes: z.array(IsolationMode).min(1),
  writable_scopes: z.array(z.string()),
});
export type ExecutorProfileInput = z.infer<typeof ExecutorProfileInput>;

export const ExecutorProfile = ExecutorProfileInput.extend({
  created_at: z.string(),
  updated_at: z.string(),
});
export type ExecutorProfile = z.infer<typeof ExecutorProfile>;
