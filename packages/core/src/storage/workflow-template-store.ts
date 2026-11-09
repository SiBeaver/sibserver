import type { JsonbParam, Sql } from './db.js';
import type { WorkflowContract, WorkflowTemplateRecord } from '../workflow/types.js';

// @bom 组织层/执行器适配
// @sibom r-wt1a — 模板引用登记：id/harness/format/path/commit/sha256，重复登记更新引用并保留 created_at
// ============================================================
// WorkflowTemplateStore — 工作流模板引用（只存引用与声明，不存执行逻辑）
// ============================================================

function rowToRecord(row: Record<string, unknown>): WorkflowTemplateRecord {
  return {
    id: String(row.id),
    harness: String(row.harness),
    format: String(row.format),
    path: String(row.path),
    commit: String(row.commit),
    sha256: String(row.sha256),
    contract: row.contract as WorkflowContract,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class WorkflowTemplateStore {
  constructor(private sql: Sql, private projectId: string) {}

  async upsert(record: WorkflowTemplateRecord): Promise<WorkflowTemplateRecord> {
    const rows = await this.sql`
      INSERT INTO workflow_templates
        (project_id, id, harness, format, path, commit, sha256, contract, created_at, updated_at)
      VALUES
        (${this.projectId}, ${record.id}, ${record.harness}, ${record.format}, ${record.path},
         ${record.commit}, ${record.sha256}, ${this.sql.json(record.contract as unknown as JsonbParam)},
         ${record.created_at}, ${record.updated_at})
      ON CONFLICT (project_id, id) DO UPDATE
      SET harness = EXCLUDED.harness,
          format = EXCLUDED.format,
          path = EXCLUDED.path,
          commit = EXCLUDED.commit,
          sha256 = EXCLUDED.sha256,
          contract = EXCLUDED.contract,
          updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  async get(id: string): Promise<WorkflowTemplateRecord | null> {
    const rows = await this.sql`
      SELECT * FROM workflow_templates
      WHERE project_id = ${this.projectId} AND id = ${id}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToRecord(rows[0] as Record<string, unknown>) : null;
  }

  async list(): Promise<WorkflowTemplateRecord[]> {
    const rows = await this.sql`
      SELECT * FROM workflow_templates
      WHERE project_id = ${this.projectId}
      ORDER BY id ASC
    `;
    return rows.map(row => rowToRecord(row as Record<string, unknown>));
  }
}
