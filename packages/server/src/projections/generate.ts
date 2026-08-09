// @sibom r-7k2m
import { getProjection } from './registry.js';
import type { OperationContext } from '../operations/context.js';
import type { ProjectionConfigEntry, GeneratedProjection } from './types.js';

export async function generate(
  ctx: OperationContext,
  config: ProjectionConfigEntry,
): Promise<GeneratedProjection> {
  if (config.constitutional) {
    throw new Error(
      `投影「${config.type}」标记为宪法级，不能自动生成。` +
      `请直接编辑：${config.outputPath ?? '（未配置路径）'}`,
    );
  }

  const template = getProjection(config.type);
  if (!template) {
    throw new Error(`未知投影类型：${config.type}`);
  }

  return template.generate(ctx, config);
}
