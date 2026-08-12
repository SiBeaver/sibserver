import type { ProjectionTemplate } from './types.js';
import { adrProjection } from './engines/adr.js';
import { roadmapProjection } from './engines/roadmap.js';
import { explorationProjection } from './engines/exploration.js';
import { rtmProjection } from './engines/rtm.js';
import { bomProjection } from './engines/bom.js';

const registry = new Map<string, ProjectionTemplate>();

export function registerProjection(template: ProjectionTemplate): void {
  registry.set(template.type, template);
}

export function getProjection(type: string): ProjectionTemplate | undefined {
  return registry.get(type);
}

export function listProjections(): ProjectionTemplate[] {
  return Array.from(registry.values());
}

// Register built-in projection types
registerProjection(adrProjection);
registerProjection(roadmapProjection);
registerProjection(explorationProjection);
registerProjection(rtmProjection);
registerProjection(bomProjection);
