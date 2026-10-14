import type { Sql, JsonbParam } from '../index.js';
import type { ProjectMeta, CreateProjectInput, UpdateProjectInput } from './types.js';

// ============================================================
// Registry — PG-backed project metadata
// ============================================================

export class Registry {
  constructor(private sql: Sql) {}

  async insertProject(input: CreateProjectInput): Promise<ProjectMeta> {
    const now = new Date().toISOString();
    const rows = await this.sql`
      INSERT INTO projects (slug, name, description, created_at, updated_at, metadata)
      VALUES (${input.slug}, ${input.name}, ${input.description ?? ''}, ${now}, ${now}, ${this.sql.json((input.metadata ?? {}) as JsonbParam)})
      RETURNING *
    `;
    return rowToMeta(rows[0]);
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const rows = await this.sql`
      SELECT * FROM projects WHERE archived = FALSE ORDER BY updated_at DESC
    `;
    return rows.map(rowToMeta);
  }

  async getProject(slug: string): Promise<ProjectMeta | null> {
    const rows = await this.sql`
      SELECT * FROM projects WHERE slug = ${slug}
    `;
    return rows.length > 0 ? rowToMeta(rows[0]) : null;
  }

  async updateProject(slug: string, patch: UpdateProjectInput): Promise<ProjectMeta | null> {
    const now = new Date().toISOString();
    const current = await this.getProject(slug);
    if (!current) return null;

    const name = patch.name ?? current.name;
    const description = patch.description ?? current.description;
    const metadata = patch.metadata ?? current.metadata;

    const rows = await this.sql`
      UPDATE projects SET name = ${name}, description = ${description},
        updated_at = ${now}, metadata = ${this.sql.json(metadata as JsonbParam)}
      WHERE slug = ${slug}
      RETURNING *
    `;
    return rows.length > 0 ? rowToMeta(rows[0]) : null;
  }

  async archiveProject(slug: string): Promise<void> {
    const now = new Date().toISOString();
    await this.sql`
      UPDATE projects SET archived = TRUE, updated_at = ${now} WHERE slug = ${slug}
    `;
  }

  async deleteProject(slug: string): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`DELETE FROM edges WHERE project_id = ${slug}`;
      await sql`DELETE FROM events WHERE project_id = ${slug}`;
      await sql`DELETE FROM nodes WHERE project_id = ${slug}`;
      await sql`DELETE FROM projects WHERE slug = ${slug}`;
    });
  }

  async getConfig(key: string): Promise<string | null> {
    const rows = await this.sql`SELECT value FROM config WHERE key = ${key}`;
    return rows.length > 0 ? rows[0].value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO config (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = ${value}
    `;
  }

  async close(): Promise<void> {
    // No-op: pool lifecycle managed centrally
  }
}

function rowToMeta(row: any): ProjectMeta {
  let parsed: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      parsed = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    } catch {
      parsed = {};
    }
  }
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived,
    metadata: parsed,
  };
}
