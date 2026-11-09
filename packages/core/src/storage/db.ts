import postgres from 'postgres';

// ============================================================
// PostgreSQL 连接池 + Schema 初始化
// ============================================================

// 历史 JSONB 双层编码归一化（幂等）：旧写入路径对 jsonb 列先 JSON.stringify 再作参数，
// postgres.js 又编码一次，导致库存 jsonb 字符串；此处还原为结构化 jsonb（写入根因已修复，此块处理存量行）。
export const JSONB_NORMALIZE_SQL = `
DO $$
BEGIN
  UPDATE nodes SET data = (data #>> '{}')::jsonb WHERE jsonb_typeof(data) = 'string';
  UPDATE nodes SET tags = (tags #>> '{}')::jsonb WHERE jsonb_typeof(tags) = 'string';
  UPDATE nodes SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
  UPDATE events SET payload = (payload #>> '{}')::jsonb WHERE jsonb_typeof(payload) = 'string';
  UPDATE events SET diff = (diff #>> '{}')::jsonb WHERE jsonb_typeof(diff) = 'string';
  UPDATE projects SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string';
  UPDATE gap_evidence SET payload = (payload #>> '{}')::jsonb WHERE jsonb_typeof(payload) = 'string';
  UPDATE gap_evidence_log SET payload = (payload #>> '{}')::jsonb WHERE jsonb_typeof(payload) = 'string';
  UPDATE gap_baseline SET bom = (bom #>> '{}')::jsonb WHERE jsonb_typeof(bom) = 'string';
END $$;
`;

export const SCHEMA_SQL = `
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

-- embedding 列保留待专项（退役向量搜索后代码无引用，删列需 DDL 迁移）
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

-- gap ledger: 派生账（基准 + 约束集 + 差距行 + 证据 + 豁免），可由 (BOM@commit, 约束集@版本, 证据集) 完全重建
CREATE TABLE IF NOT EXISTS gap_baseline (
  project_id TEXT PRIMARY KEY REFERENCES projects(slug),
  bom_commit TEXT NOT NULL,
  bom JSONB NOT NULL,
  updated_at TEXT NOT NULL
);

-- 约束集：独立版本化的对账输入，永不进入基线、不随基线前移（r-vb4d / r-vb2b）
CREATE TABLE IF NOT EXISTS gap_constraint_sets (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  set_id TEXT NOT NULL,
  set_hash TEXT NOT NULL,
  constraints JSONB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, set_id)
);

-- 最近一次对账引用的约束集（仅账本视图元数据，不属于基线）
CREATE TABLE IF NOT EXISTS gap_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(slug),
  last_constraint_set_id TEXT,
  last_constraint_set_hash TEXT,
  updated_at TEXT
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
  evidence_source TEXT NOT NULL DEFAULT '',
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

-- 身份三元组 (project, requirement_key, kind, evidence_source) 幂等迁移：
-- 1) 加列 2) 回填 evidence_source='' 的行 3) open 行去重（保留 detected_at 最早/id 最小）4) 部分唯一索引
DO $$
BEGIN
  ALTER TABLE gap_rows ADD COLUMN IF NOT EXISTS evidence_source TEXT NOT NULL DEFAULT '';

  UPDATE gap_rows SET evidence_source = 'constraint:' || source_ref
    WHERE evidence_source = '' AND kind = 'violation';
  UPDATE gap_rows SET evidence_source = 'sibom-tags:' || source_ref
    WHERE evidence_source = '' AND kind = 'absence' AND source_ref ~ '^r-[a-z0-9]{4}$';
  UPDATE gap_rows SET evidence_source = 'constraint:' || source_ref
    WHERE evidence_source = '' AND kind = 'absence';
  UPDATE gap_rows SET evidence_source = source_ref
    WHERE evidence_source = '' AND kind = 'staleness' AND source_ref LIKE '@%';
  UPDATE gap_rows SET evidence_source = 'constraint:' || source_ref
    WHERE evidence_source = '' AND kind = 'staleness' AND title LIKE '约束%';
  UPDATE gap_rows SET evidence_source = 'node:' || source_ref
    WHERE evidence_source = '' AND kind = 'staleness' AND title LIKE 'sibs 需求节点%';
  UPDATE gap_rows SET evidence_source = 'witem:' || source_ref
    WHERE evidence_source = '' AND kind = 'staleness' AND title LIKE '在办 witem%';
  UPDATE gap_rows SET evidence_source = source_ref
    WHERE evidence_source = '' AND kind = 'staleness';

  DELETE FROM gap_rows a USING gap_rows b
    WHERE a.project_id = b.project_id AND a.requirement_key = b.requirement_key
      AND a.kind = b.kind AND a.evidence_source = b.evidence_source
      AND a.status = 'open' AND b.status = 'open'
      AND (a.detected_at > b.detected_at OR (a.detected_at = b.detected_at AND a.id > b.id));

  CREATE UNIQUE INDEX IF NOT EXISTS idx_gap_rows_open_identity
    ON gap_rows(project_id, requirement_key, kind, evidence_source) WHERE status = 'open';
END $$;

ALTER TABLE gap_rows ADD COLUMN IF NOT EXISTS constraint_set_id TEXT;
ALTER TABLE gap_rows ADD COLUMN IF NOT EXISTS constraint_set_hash TEXT;

CREATE TABLE IF NOT EXISTS gap_evidence (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  source_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  baseline_commit TEXT,
  PRIMARY KEY (project_id, source_id)
);
ALTER TABLE gap_evidence ADD COLUMN IF NOT EXISTS baseline_commit TEXT;

-- 证据上报 append-only 留痕（r-el3c：基线前移后旧版本关联可查）
CREATE TABLE IF NOT EXISTS gap_evidence_log (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(slug),
  source_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  baseline_commit TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gap_evidence_log_source ON gap_evidence_log(project_id, source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gap_waivers (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);

-- 工作组织控制面：认领租约（运行时状态，不进契约/认知图谱）
CREATE TABLE IF NOT EXISTS workpack_claims (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(slug),
  workpack_id TEXT NOT NULL,
  executor TEXT NOT NULL,
  isolation_mode TEXT NOT NULL,
  isolation_id TEXT NOT NULL,
  manifest JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_workpack_claims_active
  ON workpack_claims(project_id, status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workpack_claims_one_active
  ON workpack_claims(project_id, workpack_id) WHERE status = 'active';

-- 责任认领：边界声明随认领提交（r-bc1a）；互斥按需求键（r-wp3c）
CREATE TABLE IF NOT EXISTS claims (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(slug),
  executor TEXT NOT NULL,
  requirement_keys TEXT[] NOT NULL DEFAULT '{}',
  domain TEXT NOT NULL DEFAULT 'build',
  baseline_commit TEXT NOT NULL,
  boundary JSONB NOT NULL,
  pre_authorization JSONB,
  isolation_mode TEXT NOT NULL,
  isolation_id TEXT NOT NULL,
  session_ref JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  revoked_reason TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_claims_active
  ON claims(project_id, status, lease_expires_at);

-- 需求键互斥：活跃行上唯一（先到先得，r-ar3c）
CREATE TABLE IF NOT EXISTS claim_keys (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  claim_id TEXT NOT NULL,
  requirement_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (project_id, claim_id, requirement_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_keys_one_active
  ON claim_keys(project_id, requirement_key) WHERE status = 'active';

-- 契约变更/重规划提案（运行时状态；契约提案由基线前移确认）
CREATE TABLE IF NOT EXISTS workpack_proposals (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(slug),
  workpack_id TEXT,
  kind TEXT NOT NULL,
  proposer TEXT NOT NULL,
  requirement_keys TEXT[] NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  detail JSONB NOT NULL,
  refs JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL,
  confirmed_commit TEXT,
  confirmed_by TEXT,
  resolved_at TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_workpack_proposals_status
  ON workpack_proposals(project_id, status, created_at);
-- 责任认领的契约提案（r-bc2b：契约子树写入仅限提案）
ALTER TABLE workpack_proposals ADD COLUMN IF NOT EXISTS claim_id TEXT;
-- 提案正文不入控制面：只存 BOM/git 引用（r-ar7g）；detail 列保留历史，新提案写空对象占位
ALTER TABLE workpack_proposals ADD COLUMN IF NOT EXISTS refs JSONB NOT NULL DEFAULT '[]';

-- 执行者画像：声明性能力记录（不路由模型，不做分派匹配）
CREATE TABLE IF NOT EXISTS executor_profiles (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  executor TEXT NOT NULL,
  harness TEXT NOT NULL,
  models TEXT[] NOT NULL DEFAULT '{}',
  concurrency INTEGER NOT NULL,
  isolation_modes TEXT[] NOT NULL DEFAULT '{}',
  writable_scopes TEXT[] NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, executor)
);

-- 工作流模板引用（r-ea2b：sibeaver 只持有引用与校验，不执行 workflow）
CREATE TABLE IF NOT EXISTS workflow_templates (
  project_id TEXT NOT NULL REFERENCES projects(slug),
  id TEXT NOT NULL,
  harness TEXT NOT NULL,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  commit TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  contract JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
` + JSONB_NORMALIZE_SQL;

let _poolPromise: Promise<postgres.Sql> | null = null;

export function getConnectionString(): string {
  return process.env.DATABASE_URL
    ?? 'postgres://sibeaver:sibeaver@10.1.1.40:5432/sibeaver';
}

export function getPool(): Promise<postgres.Sql> {
  if (!_poolPromise) {
    _poolPromise = (async () => {
      const sql = postgres(getConnectionString(), {
        max: 20,
        idle_timeout: 30,
      });
      await sql.unsafe(SCHEMA_SQL);
      return sql;
    })();
  }
  return _poolPromise;
}

export async function closePool(): Promise<void> {
  if (_poolPromise) {
    const sql = await _poolPromise;
    await sql.end();
    _poolPromise = null;
  }
}

export type Sql = postgres.Sql;

/** postgres.js jsonb 参数类型（JSONValue）——unknown/宽泛 JSON 来源收窄入参用 */
export type JsonbParam = Parameters<Sql['json']>[0];
