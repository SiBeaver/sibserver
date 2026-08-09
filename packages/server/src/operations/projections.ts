import { generate } from '../projections/generate.js';
import { listProjections } from '../projections/registry.js';
import type { OperationContext } from './context.js';
import type { ProjectionConfigEntry } from '../projections/types.js';

export interface GenerateProjectionInput {
  type: string;
  /** Optional config override – normally read from project metadata */
  config?: ProjectionConfigEntry;
}

export async function generateProjection(ctx: OperationContext, input: GenerateProjectionInput) {
  const config = input.config;
  if (!config) {
    throw new Error(`投影类型「${input.type}」的配置未提供`);
  }

  const result = await generate(ctx, config);
  return result;
}

export async function listProjectionTypes() {
  return listProjections().map(t => ({
    type: t.type,
    label: t.label,
    description: t.description,
  }));
}
