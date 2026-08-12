import type { CognitiveNode } from '@sibeaver/core';

/**
 * Extract embeddable text content from a node.
 * Returns null for node types that don't need embeddings.
 */
export function getEmbeddingText(node: CognitiveNode): string | null {
  switch (node.type) {
    case 'knowledge':
      return `[${node.domain}] ${node.title}: ${node.description}`;
    case 'decision':
      return `[决策] ${node.title}: ${node.context} | ${node.rationale}`;
    default:
      return null;
  }
}

/** Node types that should have embeddings generated */
export const EMBEDDABLE_TYPES = ['knowledge', 'decision'] as const;
