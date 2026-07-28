import postgres from 'postgres';

// ============================================================
// PostgreSQL 连接池 + Schema 初始化
// ============================================================

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES ('default_project', 'default')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(slug),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}',
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL,
  annotation TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, source_id) REFERENCES nodes(project_id, id),
  FOREIGN KEY (project_id, target_id) REFERENCES nodes(project_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(slug),
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  operation TEXT NOT NULL,
  node_id TEXT,
  node_type TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  diff JSONB,
  context TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(project_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(project_id, status);
CREATE INDEX IF NOT EXISTS idx_nodes_type_status ON nodes(project_id, type, status);
CREATE INDEX IF NOT EXISTS idx_nodes_updated_at ON nodes(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_nodes_fts ON nodes USING GIN(search_vector);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(project_id, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(project_id, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(project_id, relation);
CREATE INDEX IF NOT EXISTS idx_edges_source_relation ON edges(project_id, source_id, relation);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(project_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(project_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_node_id ON events(project_id, node_id);

-- pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding vector(1024);
CREATE INDEX IF NOT EXISTS idx_nodes_embedding
  ON nodes USING hnsw (embedding vector_cosine_ops);

-- knowledge tree: content, parent_id, pinned, sort_order
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS parent_id TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(project_id, parent_id);

-- Update search_vector to include content (idempotent: check column definition)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'nodes' AND column_name = 'search_vector'
      AND generation_expression LIKE '%content%'
  ) THEN
    ALTER TABLE nodes DROP COLUMN IF EXISTS search_vector;
    ALTER TABLE nodes ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(content, ''))
    ) STORED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_nodes_fts ON nodes USING GIN(search_vector);

-- gap ledger: 派生账（基准 + 差距行 + 证据 + 豁免），可由 (BOM@commit, 证据集) 完全重建
CREATE TABLE IF NOT EXISTS gap_baseline (
  project_id TEXT PRIMARY KEY REFERENCES projects(slug),
  bom_commit TEXT NOT NULL,
  bom JSONB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gap_rows (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(slug),
  requirement_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  bom_commit TEXT NOT NULL,
  condition_fingerprint TEXT NOT NULL,
  evidence_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  superseded_at TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_gap_rows_status ON gap_rows(project_id, status);
CREATE INDEX IF NOT EXISTS idx_gap_rows_key ON gap_rows(project_id, requirement_key);

CREATE TABLE IF NOT EXISTS gap_evidence (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  source_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source_id)
);

CREATE TABLE IF NOT EXISTS gap_waivers (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);
`;

let _sql: postgres.Sql | null = null;

export function getConnectionString(): string {
  return process.env.DATABASE_URL
    ?? 'postgres://sibeaver:sibeaver@10.1.1.40:5432/sibeaver';
}

export async function getPool(): Promise<postgres.Sql> {
  if (_sql) return _sql;
  _sql = postgres(getConnectionString(), {
    max: 20,
    idle_timeout: 30,
  });
  await _sql.unsafe(SCHEMA_SQL);
  return _sql;
}

export async function closePool(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

export type Sql = postgres.Sql;
