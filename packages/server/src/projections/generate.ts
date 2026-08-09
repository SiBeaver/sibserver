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
      `Projection "${config.type}" is marked constitutional and cannot be auto-generated. ` +
      `Edit it directly at: ${config.outputPath ?? '(no path configured)'}`,
    );
  }

  const template = getProjection(config.type);
  if (!template) {
    throw new Error(`Unknown projection type: ${config.type}`);
  }

  return template.generate(ctx, config);
}
