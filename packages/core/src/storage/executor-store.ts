import type { Sql } from './db.js';
import type { ExecutorProfile } from '../executor/types.js';

// ============================================================
// ExecutorStore — 执行者画像（声明性记录，不做模型路由）
// ============================================================

function rowToProfile(row: Record<string, unknown>): ExecutorProfile {
  const asStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : [];
  return {
    executor: String(row.executor),
    harness: String(row.harness),
    models: asStrings(row.models),
    concurrency: Number(row.concurrency),
    isolation_modes: asStrings(row.isolation_modes) as ExecutorProfile['isolation_modes'],
    writable_scopes: asStrings(row.writable_scopes),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class ExecutorStore {
  constructor(private sql: Sql, private projectId: string) {}

  async upsert(profile: ExecutorProfile): Promise<ExecutorProfile> {
    const rows = await this.sql`
      INSERT INTO executor_profiles
        (project_id, executor, harness, models, concurrency, isolation_modes,
         writable_scopes, created_at, updated_at)
      VALUES
        (${this.projectId}, ${profile.executor}, ${profile.harness}, ${profile.models},
         ${profile.concurrency}, ${profile.isolation_modes}, ${profile.writable_scopes},
         ${profile.created_at}, ${profile.updated_at})
      ON CONFLICT (project_id, executor) DO UPDATE
      SET harness = EXCLUDED.harness,
          models = EXCLUDED.models,
          concurrency = EXCLUDED.concurrency,
          isolation_modes = EXCLUDED.isolation_modes,
          writable_scopes = EXCLUDED.writable_scopes,
          updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    return rowToProfile(rows[0] as Record<string, unknown>);
  }

  async get(executor: string): Promise<ExecutorProfile | null> {
    const rows = await this.sql`
      SELECT * FROM executor_profiles
      WHERE project_id = ${this.projectId} AND executor = ${executor}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToProfile(rows[0] as Record<string, unknown>) : null;
  }

  async list(): Promise<ExecutorProfile[]> {
    const rows = await this.sql`
      SELECT * FROM executor_profiles
      WHERE project_id = ${this.projectId}
      ORDER BY executor ASC
    `;
    return rows.map(row => rowToProfile(row as Record<string, unknown>));
  }
}
