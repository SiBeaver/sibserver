import type { Sql } from './db.js';
import type { CognitiveNode, NodeType } from '../nodes/types.js';
import type { Edge } from '../edges/types.js';
import type { EventRecord } from '../events/types.js';

// ============================================================
// Row ↔ Node 转换
// ============================================================

function rowToNode(row: any): CognitiveNode {
  const { project_id, search_vector, embedding, data, tags, metadata, ...rest } = row;
  const parsedData = typeof data === 'string' ? JSON.parse(data) : (data ?? {});
  const parsedTags = typeof tags === 'string' ? JSON.parse(tags) : (tags ?? []);
  const parsedMeta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata ?? {});
  return {
    ...parsedData,
    ...rest,
    tags: parsedTags,
    metadata: parsedMeta,
    createdAt: rest.created_at,
    updatedAt: rest.updated_at,
  } as CognitiveNode;
}

function rowToEdge(row: any): Edge {
  const { project_id, ...rest } = row;
  return rest as Edge;
}

function rowToEvent(row: any): EventRecord {
  const { project_id, payload, diff, ...rest } = row;
  return {
    ...rest,
    payload: typeof payload === 'string' ? JSON.parse(payload) : (payload ?? {}),
    diff: diff == null ? null : (typeof diff === 'string' ? JSON.parse(diff) : diff),
  } as EventRecord;
}

// ============================================================
// NodeStore
// ============================================================

export class NodeStore {
  constructor(private sql: Sql, private projectId: string) {}

  async insert(node: CognitiveNode): Promise<void> {
    const { id, type, title, description, status, tags, created_at, updated_at, metadata, content, parent_id, pinned, sort_order, ...data } = node as any;
    await this.sql`
      INSERT INTO nodes (id, project_id, type, title, description, status, tags, created_at, updated_at, metadata, data, content, parent_id, pinned, sort_order)
      VALUES (${id}, ${this.projectId}, ${type}, ${title ?? ''}, ${description ?? ''}, ${status},
              ${this.sql.json(tags ?? [])}, ${created_at}, ${updated_at},
              ${this.sql.json(metadata ?? {})}, ${this.sql.json(data)},
              ${content ?? ''}, ${parent_id ?? null}, ${pinned ?? false}, ${sort_order ?? 0})
    `;
  }

  async update(node: CognitiveNode): Promise<void> {
    const { id, type, title, description, status, tags, created_at, updated_at, metadata, content, parent_id, pinned, sort_order, ...data } = node as any;
    await this.sql`
      UPDATE nodes SET
        title = ${title ?? ''}, description = ${description ?? ''}, status = ${status},
        tags = ${this.sql.json(tags ?? [])}, updated_at = ${updated_at},
        metadata = ${this.sql.json(metadata ?? {})}, data = ${this.sql.json(data)},
        content = ${content ?? ''}, parent_id = ${parent_id ?? null},
        pinned = ${pinned ?? false}, sort_order = ${sort_order ?? 0},
        embedding = NULL
      WHERE id = ${id} AND project_id = ${this.projectId}
    `;
  }

  async getById(id: string): Promise<CognitiveNode | null> {
    const rows = await this.sql`
      SELECT * FROM nodes WHERE id = ${id} AND project_id = ${this.projectId}
    `;
    return rows.length > 0 ? rowToNode(rows[0]) : null;
  }

  async getByType(type: NodeType): Promise<CognitiveNode[]> {
    const rows = await this.sql`
      SELECT * FROM nodes WHERE type = ${type} AND project_id = ${this.projectId}
    `;
    return rows.map(rowToNode);
  }

  async getByTypeAndStatus(type: NodeType, status: string): Promise<CognitiveNode[]> {
    const rows = await this.sql`
      SELECT * FROM nodes WHERE type = ${type} AND status = ${status} AND project_id = ${this.projectId}
    `;
    return rows.map(rowToNode);
  }

  async delete(id: string): Promise<void> {
    await this.sql`DELETE FROM nodes WHERE id = ${id} AND project_id = ${this.projectId}`;
  }

  async search(query: string): Promise<CognitiveNode[]> {
    // 将空格分隔的词转为 tsquery OR 格式，使用前缀匹配
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const tsquery = terms.map(t => t.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '')).filter(Boolean).map(t => `${t}:*`).join(' | ');
    if (!tsquery) return [];
    const rows = await this.sql`
      SELECT * FROM nodes
      WHERE project_id = ${this.projectId}
        AND search_vector @@ to_tsquery('simple', ${tsquery})
      ORDER BY ts_rank(search_vector, to_tsquery('simple', ${tsquery})) DESC
    `;
    return rows.map(rowToNode);
  }

  // ---- Knowledge tree methods ----

  async getKnowledgeTree(): Promise<CognitiveNode[]> {
    const rows = await this.sql`
      SELECT * FROM nodes
      WHERE project_id = ${this.projectId} AND type = 'knowledge'
      ORDER BY pinned DESC, sort_order ASC, created_at ASC
    `;
    return rows.map(rowToNode);
  }

  async getChildren(parentId: string | null): Promise<CognitiveNode[]> {
    const rows = parentId
      ? await this.sql`
          SELECT * FROM nodes
          WHERE project_id = ${this.projectId} AND parent_id = ${parentId}
          ORDER BY sort_order ASC, created_at ASC
        `
      : await this.sql`
          SELECT * FROM nodes
          WHERE project_id = ${this.projectId} AND parent_id IS NULL AND type = 'knowledge'
          ORDER BY pinned DESC, sort_order ASC, created_at ASC
        `;
    return rows.map(rowToNode);
  }

  async updateParent(id: string, parentId: string | null, sortOrder?: number): Promise<void> {
    await this.sql`
      UPDATE nodes SET parent_id = ${parentId}, sort_order = ${sortOrder ?? 0}, updated_at = ${new Date().toISOString()}
      WHERE id = ${id} AND project_id = ${this.projectId}
    `;
  }

  async updatePinned(id: string, pinned: boolean): Promise<void> {
    await this.sql`
      UPDATE nodes SET pinned = ${pinned}, updated_at = ${new Date().toISOString()}
      WHERE id = ${id} AND project_id = ${this.projectId}
    `;
  }

  async getIsolatedNodes(maxEdges: number, limit: number = 10): Promise<CognitiveNode[]> {
    const rows = await this.sql`
      SELECT n.* FROM nodes n
      LEFT JOIN (
        SELECT source_id AS node_id FROM edges WHERE project_id = ${this.projectId}
        UNION ALL
        SELECT target_id AS node_id FROM edges WHERE project_id = ${this.projectId}
      ) e ON e.node_id = n.id
      WHERE n.project_id = ${this.projectId}
      GROUP BY n.id, n.project_id
      HAVING COUNT(e.node_id) <= ${maxEdges}
      ORDER BY n.created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToNode);
  }
}

// ============================================================
// EdgeStore
// ============================================================

export class EdgeStore {
  constructor(private sql: Sql, private projectId: string) {}

  async insert(edge: Edge): Promise<void> {
    const e = edge as any;
    await this.sql`
      INSERT INTO edges (id, project_id, source_id, target_id, relation, weight, annotation, created_at)
      VALUES (${e.id}, ${this.projectId}, ${e.source_id}, ${e.target_id},
              ${e.relation}, ${e.weight ?? null}, ${e.annotation ?? null}, ${e.created_at})
    `;
  }

  async getBySource(sourceId: string): Promise<Edge[]> {
    const rows = await this.sql`
      SELECT * FROM edges WHERE source_id = ${sourceId} AND project_id = ${this.projectId}
    `;
    return rows.map(rowToEdge);
  }

  async getByTarget(targetId: string): Promise<Edge[]> {
    const rows = await this.sql`
      SELECT * FROM edges WHERE target_id = ${targetId} AND project_id = ${this.projectId}
    `;
    return rows.map(rowToEdge);
  }

  async getByNode(nodeId: string): Promise<Edge[]> {
    const rows = await this.sql`
      SELECT * FROM edges
      WHERE (source_id = ${nodeId} OR target_id = ${nodeId}) AND project_id = ${this.projectId}
    `;
    return rows.map(rowToEdge);
  }

  async delete(id: string): Promise<void> {
    await this.sql`DELETE FROM edges WHERE id = ${id} AND project_id = ${this.projectId}`;
  }
}

// ============================================================
// EventStore
// ============================================================

export class EventStore {
  constructor(private sql: Sql, private projectId: string) {}

  async insert(event: EventRecord): Promise<void> {
    const e = event as any;
    await this.sql`
      INSERT INTO events (id, project_id, timestamp, event_type, actor, operation, node_id, node_type, payload, diff, context)
      VALUES (${e.id}, ${this.projectId}, ${e.timestamp}, ${e.event_type}, ${e.actor ?? 'user'},
              ${e.operation}, ${e.node_id ?? null}, ${e.node_type ?? null},
              ${this.sql.json(e.payload ?? {})}, ${e.diff ? this.sql.json(e.diff) : null}, ${e.context ?? null})
    `;
  }

  async getByNode(nodeId: string): Promise<EventRecord[]> {
    const rows = await this.sql`
      SELECT * FROM events WHERE node_id = ${nodeId} AND project_id = ${this.projectId} ORDER BY timestamp ASC
    `;
    return rows.map(rowToEvent);
  }

  async getRecent(limit: number = 20): Promise<EventRecord[]> {
    const rows = await this.sql`
      SELECT * FROM events WHERE project_id = ${this.projectId} ORDER BY timestamp DESC LIMIT ${limit}
    `;
    return rows.map(rowToEvent);
  }

  async getSince(since: string): Promise<EventRecord[]> {
    const rows = await this.sql`
      SELECT * FROM events WHERE timestamp >= ${since} AND project_id = ${this.projectId} ORDER BY timestamp ASC
    `;
    return rows.map(rowToEvent);
  }
}
