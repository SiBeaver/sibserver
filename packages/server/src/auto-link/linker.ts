import { ulid } from 'ulidx';
import type { OperationContext } from '@sibeaver/core';
import type { CognitiveNode, NodeType } from '@sibeaver/core';
import type { Edge, RelationType } from '@sibeaver/core';
import { RELATION_CONSTRAINTS, validateRelation } from '@sibeaver/core';
import { jsonCompletion, type ChatMessage } from '../llm-client.js';
import { LINK_STRATEGIES } from './strategies.js';
import { config } from '../config/index.js';

export interface AutoLinkResult {
  node_id: string;
  created_edges: Edge[];
  skipped: number;
  candidates_found: number;
}

interface LlmSuggestion {
  target_id: string;
  relation: RelationType;
  direction: 'outgoing' | 'incoming';
  annotation: string;
}

interface LlmResponse {
  links: LlmSuggestion[];
}

export async function autoLink(
  ctx: OperationContext,
  nodeId: string,
  options?: { useSimilarity?: boolean },
): Promise<AutoLinkResult> {
  const node = await ctx.nodes.getById(nodeId);
  if (!node) throw new Error(`节点不存在：${nodeId}`);

  const strategy = LINK_STRATEGIES[node.type as NodeType];
  const existingEdges = await ctx.edges.getByNode(nodeId);
  const linkedIds = new Set(existingEdges.flatMap(e => [e.source_id, e.target_id]));
  linkedIds.add(nodeId);

  const candidates = await findCandidates(ctx, node, strategy, linkedIds, options?.useSimilarity ?? false);
  if (candidates.length === 0) {
    return { node_id: nodeId, created_edges: [], skipped: 0, candidates_found: 0 };
  }

  const suggestions = await inferLinks(node, candidates, strategy);

  const created: Edge[] = [];
  let skipped = 0;

  for (const s of suggestions) {
    const candidate = candidates.find(c => c.id === s.target_id);
    if (!candidate) { skipped++; continue; }

    const sourceType = s.direction === 'outgoing' ? node.type : candidate.type;
    const targetType = s.direction === 'outgoing' ? candidate.type : node.type;

    if (!validateRelation(s.relation, sourceType as NodeType, targetType as NodeType)) {
      skipped++;
      continue;
    }

    const sourceId = s.direction === 'outgoing' ? nodeId : s.target_id;
    const targetId = s.direction === 'outgoing' ? s.target_id : nodeId;

    const alreadyExists = existingEdges.some(
      e => e.source_id === sourceId && e.target_id === targetId && e.relation === s.relation
    );
    if (alreadyExists) { skipped++; continue; }

    const now = new Date().toISOString();
    const edge: Edge = {
      id: ulid(),
      source_id: sourceId,
      target_id: targetId,
      relation: s.relation,
      weight: null,
      annotation: s.annotation || null,
      created_at: now,
    };

    await ctx.edges.insert(edge);
    await ctx.events.emit({
      event_type: 'graph.edge_created',
      actor: 'system',
      operation: 'auto_link',
      node_id: sourceId,
      node_type: sourceType,
      payload: { source_id: sourceId, target_id: targetId, relation: s.relation, auto: true },
    });

    created.push(edge);
  }

  return { node_id: nodeId, created_edges: created, skipped, candidates_found: candidates.length };
}

async function findCandidates(
  ctx: OperationContext,
  node: CognitiveNode,
  strategy: typeof LINK_STRATEGIES[NodeType],
  excludeIds: Set<string>,
  useSimilarity: boolean,
): Promise<CognitiveNode[]> {
  const all = new Map<string, CognitiveNode>();

  if (useSimilarity) {
    const results = await ctx.nodes.similaritySearch(
      [], // will be handled by caller if embedding exists
      strategy.maxCandidates,
      strategy.candidateTypes,
    ).catch(() => []);
    for (const r of results) {
      if (!excludeIds.has(r.id)) all.set(r.id, r);
    }
  }

  const searchText = `${node.title} ${node.description}`.trim();
  if (searchText) {
    const ftsResults = await ctx.nodes.search(searchText).catch(() => []);
    for (const r of ftsResults) {
      if (!excludeIds.has(r.id) && strategy.candidateTypes.includes(r.type as NodeType)) {
        all.set(r.id, r);
      }
    }
  }

  if (all.size < 3) {
    for (const type of strategy.candidateTypes) {
      const nodes = await ctx.nodes.getByType(type as NodeType);
      for (const n of nodes) {
        if (!excludeIds.has(n.id)) all.set(n.id, n);
        if (all.size >= strategy.maxCandidates) break;
      }
      if (all.size >= strategy.maxCandidates) break;
    }
  }

  return [...all.values()].slice(0, strategy.maxCandidates);
}

async function inferLinks(
  node: CognitiveNode,
  candidates: CognitiveNode[],
  strategy: typeof LINK_STRATEGIES[NodeType],
): Promise<LlmSuggestion[]> {
  const constraintsSummary = buildConstraintsSummary(node.type as NodeType, candidates);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a knowledge graph linking assistant. Given a source node and candidate nodes, determine which candidates should be linked and with what relation type.

Rules:
- Only suggest links that are semantically meaningful (not just superficially similar).
- Each link must respect the RELATION_CONSTRAINTS (provided below).
- "direction" indicates whether the source node is the edge source ("outgoing") or target ("incoming").
- Return at most 5 links. Prefer quality over quantity. Return empty array if no good links exist.
- Annotation should be a brief reason (max 20 chars) in the same language as the node content.

RELATION_CONSTRAINTS (source_type -> relation -> target_type):
${constraintsSummary}

Preferred relations for this node type: ${strategy.preferredRelations.join(', ')}

Respond with JSON: {"links": [{"target_id": "...", "relation": "...", "direction": "outgoing"|"incoming", "annotation": "..."}]}`,
    },
    {
      role: 'user',
      content: `SOURCE NODE:
- id: ${node.id}
- type: ${node.type}
- title: ${node.title}
- description: ${node.description}
${nodeSpecificFields(node)}

CANDIDATES:
${candidates.map((c, i) => `${i + 1}. [${c.type}] id=${c.id} title="${c.title}" desc="${c.description.slice(0, 100)}"`).join('\n')}`,
    },
  ];

  try {
    const result = await jsonCompletion<LlmResponse>(messages, { model: config.llmFlashModel });
    return (result.links ?? []).slice(0, 5);
  } catch (err) {
    console.error('[auto-link] LLM inference failed:', err);
    return [];
  }
}

function buildConstraintsSummary(sourceType: NodeType, candidates: CognitiveNode[]): string {
  const candidateTypes: string[] = [...new Set(candidates.map(c => c.type))];
  const lines: string[] = [];

  for (const [relation, constraint] of Object.entries(RELATION_CONSTRAINTS)) {
    const sourceMatch = (constraint.source as string[]).includes(sourceType);
    const targetMatch = (constraint.target as string[]).some(t => candidateTypes.includes(t));
    const reverseSourceMatch = (constraint.source as string[]).some(s => candidateTypes.includes(s));
    const reverseTargetMatch = (constraint.target as string[]).includes(sourceType);

    if (sourceMatch && targetMatch) {
      lines.push(`${sourceType} -[${relation}]-> ${(constraint.target as string[]).filter(t => candidateTypes.includes(t)).join('|')}`);
    }
    if (reverseSourceMatch && reverseTargetMatch) {
      lines.push(`${(constraint.source as string[]).filter(s => candidateTypes.includes(s)).join('|')} -[${relation}]-> ${sourceType}`);
    }
  }

  return lines.join('\n');
}

function nodeSpecificFields(node: CognitiveNode): string {
  switch (node.type) {
    case 'knowledge':
      return `- domain: ${node.domain}\n- confidence: ${node.confidence}`;
    case 'requirement':
      return `- source: ${node.source}\n- priority: ${node.priority}`;
    case 'goal':
      return `- success_criteria: ${node.success_criteria.join('; ')}`;
    case 'decision':
      return `- context: ${node.context}\n- rationale: ${node.rationale}`;
    case 'risk':
      return `- likelihood: ${node.likelihood}\n- impact: ${node.impact}`;
    default:
      return '';
  }
}
