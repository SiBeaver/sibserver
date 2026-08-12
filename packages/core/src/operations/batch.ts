import type { OperationContext } from './context.js';

// ============================================================
// batch_operations — 批量执行多个操作，部分失败不中断
// ============================================================

export interface BatchOperationItem {
  op: string;
  params: Record<string, unknown>;
}

export interface BatchOperationsInput {
  operations: BatchOperationItem[];
}

export interface BatchResultItem {
  index: number;
  op: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export type OperationHandlerMap = Record<string, (ctx: OperationContext, input: any) => Promise<any>>;

/**
 * 批量执行操作。每个操作独立执行，部分失败不影响其余。
 * 返回每个操作的执行结果和成功/失败状态。
 */
export async function batchOperations(
  ctx: OperationContext,
  input: BatchOperationsInput,
  handlers: OperationHandlerMap,
): Promise<{ results: BatchResultItem[]; summary: { total: number; succeeded: number; failed: number } }> {
  if (!input.operations || !Array.isArray(input.operations)) {
    throw new Error('operations 必须是非空数组');
  }
  if (input.operations.length === 0) {
    throw new Error('operations 数组不能为空');
  }
  if (input.operations.length > 50) {
    throw new Error('批量大小上限：单次最多 50 个操作');
  }

  const results: BatchResultItem[] = [];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < input.operations.length; i++) {
    const item = input.operations[i];
    const handler = handlers[item.op];

    if (!handler) {
      results.push({ index: i, op: item.op, success: false, error: `Unknown operation: ${item.op}` });
      failed++;
      continue;
    }

    try {
      const result = await handler(ctx, item.params);
      results.push({ index: i, op: item.op, success: true, result });
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ index: i, op: item.op, success: false, error: msg });
      failed++;
    }
  }

  return {
    results,
    summary: { total: input.operations.length, succeeded, failed },
  };
}
