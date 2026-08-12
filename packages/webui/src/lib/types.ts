export interface ProjectMeta {
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  metadata: Record<string, unknown>;
}

// Mirror of backend node types — camelCase field names matching REST API responses

export interface CognitiveNode {
  id: string;
  type: 'witem' | 'decision' | 'risk' | 'tech_debt' | 'artifact' | 'knowledge' | 'requirement';
  title: string;
  description: string;
  status: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  // witem
  horizon?: 'short' | 'medium' | 'long';
  successCriteria?: string[];
  priority?: 'critical' | 'high' | 'medium' | 'low';
  // decision
  context?: string;
  rationale?: string;
  alternativesConsidered?: { option: string; pros: string[]; cons: string[]; reasonRejected: string }[];
  consequences?: string[];
  supersededBy?: string | null;
  // risk
  likelihood?: 'low' | 'medium' | 'high';
  impact?: 'low' | 'medium' | 'high' | 'critical';
  mitigationStrategy?: string | null;
  triggerConditions?: string[];
  // tech_debt
  severity?: 'low' | 'medium' | 'high' | 'critical';
  affectedArea?: string;
  costOfDelay?: string;
  resolutionApproach?: string | null;
  // knowledge
  domain?: string;
  confidence?: 'low' | 'medium' | 'high';
  source?: string;
  // artifact
  artifactType?: string;
  uri?: string | null;
  contentSummary?: string | null;
  // requirement
  sourceDetail?: string | null;
}

export interface RoadmapItem {
  node: CognitiveNode;
  children: RoadmapItem[];
  progress: { total: number; done: number };
}

export interface RoadmapResponse {
  roadmap: RoadmapItem[];
}

export interface BlockerItem {
  blocker: CognitiveNode;
  blocks: CognitiveNode[];
}

export interface BlockersResponse {
  blockers: BlockerItem[];
}

export interface ProjectState {
  activeWitems: CognitiveNode[];
  recentDecisions: CognitiveNode[];
  openRisks: CognitiveNode[];
  criticalTechDebt: CognitiveNode[];
  requirements: CognitiveNode[];
  openRequirements: CognitiveNode[];
  statistics: {
    totalWitems: number;
    achievedWitems: number;
    openRisks: number;
    techDebtItems: number;
    totalRequirements: number;
    openRequirements: number;
  };
}

export interface EventRecord {
  id: string;
  timestamp: string;
  eventType: string;
  actor: string;
  operation: string;
  nodeId: string | null;
  nodeType: string | null;
  payload: Record<string, unknown>;
  context: string | null;
}

export interface SemanticEdge {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  annotation: string | null;
  createdAt: string;
}

export interface NodeContext {
  node: CognitiveNode;
  edges: SemanticEdge[];
  neighbors: CognitiveNode[];
  events: EventRecord[];
}
