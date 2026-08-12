import type { CognitiveNode } from './nodes/types.js';
import type { Edge } from './edges/types.js';

// Minimal context interface for projection engines.
// OperationContext structurally satisfies this.
export interface ProjectionContext {
  nodes: {
    getByType(type: string): Promise<CognitiveNode[]>;
    getById(id: string): Promise<CognitiveNode | null>;
  };
  edges: {
    getByNode(nodeId: string): Promise<Edge[]>;
  };
}
