import { z } from 'zod';
import type { ProjectionContext } from '@sibeaver/core';

// ============================================================
// Projection config — stored in ProjectMeta.metadata.projections
// ============================================================

export const ProjectionConfigEntry = z.object({
  type: z.string(),
  label: z.string(),
  outputPath: z.string().optional(),
  constitutional: z.boolean().default(false),
  filters: z.object({
    status: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    domain: z.string().optional(),
    horizon: z.array(z.string()).optional(),
  }).optional().default({}),
});
export type ProjectionConfigEntry = z.infer<typeof ProjectionConfigEntry>;

export const ProjectionsConfig = z.record(z.string(), ProjectionConfigEntry);
export type ProjectionsConfig = z.infer<typeof ProjectionsConfig>;

// ============================================================
// Projection template — implemented by each engine
// ============================================================

export interface GeneratedProjection {
  markdown: string;
  metadata: {
    title: string;
    generatedAt: string;
    sourceNodeCount: number;
    sourceNodeIds: string[];
  };
}

export interface ProjectionTemplate {
  type: string;
  label: string;
  description: string;
  generate(ctx: ProjectionContext, config: ProjectionConfigEntry): Promise<GeneratedProjection>;
}
