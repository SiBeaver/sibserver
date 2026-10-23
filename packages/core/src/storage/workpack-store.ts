import type { JsonbParam, Sql } from './db.js';
import type { ClaimView, IsolationMode, Workpack } from '../workpack/types.js';

// ============================================================
// WorkpackStore — 认领租约（运行时状态，不进契约与认知图谱）
// ============================================================

export interface ClaimRecord {
  id: string;
  workpack_id: string;
  executor: string;
  isolation_mode: IsolationMode;
  isolation_id: string;
  manifest: Workpack;
  status: string;
  lease_expires_at: string;
  heartbeat_at: string;
  created_at: string;
  released_at: string | null;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToClaim(row: Record<string, unknown>): ClaimRecord {
  return {
    id: String(row.id),
    workpack_id: String(row.workpack_id),
    executor: String(row.executor),
    isolation_mode: row.isolation_mode as IsolationMode,
    isolation_id: String(row.isolation_id),
    manifest: parseJson<Workpack>(row.manifest),
    status: String(row.status),
    lease_expires_at: String(row.lease_expires_at),
    heartbeat_at: String(row.heartbeat_at),
    created_at: String(row.created_at),
    released_at: optionalString(row.released_at),
  };
}

export function toClaimView(claim: ClaimRecord): ClaimView {
  return {
    id: claim.id,
    workpack_id: claim.workpack_id,
    executor: claim.executor,
    isolation_mode: claim.isolation_mode,
    isolation_id: claim.isolation_id,
    lease_expires_at: claim.lease_expires_at,
    heartbeat_at: claim.heartbeat_at,
    created_at: claim.created_at,
  };
}

export class WorkpackStore {
  constructor(private sql: Sql, private projectId: string) {}

  async expireStale(now: string): Promise<number> {
    const rows = await this.sql`
      UPDATE workpack_claims SET status = 'expired'
      WHERE project_id = ${this.projectId} AND status = 'active' AND lease_expires_at <= ${now}
      RETURNING id
    `;
    return rows.length;
  }

  async getActiveClaims(): Promise<ClaimRecord[]> {
    const rows = await this.sql`
      SELECT * FROM workpack_claims
      WHERE project_id = ${this.projectId} AND status = 'active'
      ORDER BY created_at ASC
    `;
    return rows.map(row => rowToClaim(row as Record<string, unknown>));
  }

  async getActiveClaimByWorkpack(workpackId: string): Promise<ClaimRecord | null> {
    const rows = await this.sql`
      SELECT * FROM workpack_claims
      WHERE project_id = ${this.projectId} AND workpack_id = ${workpackId} AND status = 'active'
      LIMIT 1
    `;
    return rows.length > 0 ? rowToClaim(rows[0] as Record<string, unknown>) : null;
  }

  async insertClaim(claim: ClaimRecord): Promise<void> {
    await this.sql`
      INSERT INTO workpack_claims
        (id, project_id, workpack_id, executor, isolation_mode, isolation_id, manifest,
         status, lease_expires_at, heartbeat_at, created_at, released_at)
      VALUES
        (${claim.id}, ${this.projectId}, ${claim.workpack_id}, ${claim.executor},
         ${claim.isolation_mode}, ${claim.isolation_id},
         ${this.sql.json(claim.manifest as unknown as JsonbParam)},
         ${claim.status}, ${claim.lease_expires_at}, ${claim.heartbeat_at},
         ${claim.created_at}, ${claim.released_at})
    `;
  }

  async updateClaimLease(id: string, leaseExpiresAt: string, heartbeatAt: string): Promise<void> {
    await this.sql`
      UPDATE workpack_claims
      SET lease_expires_at = ${leaseExpiresAt}, heartbeat_at = ${heartbeatAt}
      WHERE project_id = ${this.projectId} AND id = ${id} AND status = 'active'
    `;
  }

  async updateClaimManifest(id: string, manifest: Workpack): Promise<void> {
    await this.sql`
      UPDATE workpack_claims
      SET manifest = ${this.sql.json(manifest as unknown as JsonbParam)}
      WHERE project_id = ${this.projectId} AND id = ${id} AND status = 'active'
    `;
  }

  async closeClaim(id: string, status: 'released' | 'failed', releasedAt: string): Promise<void> {
    await this.sql`
      UPDATE workpack_claims
      SET status = ${status}, released_at = ${releasedAt}
      WHERE project_id = ${this.projectId} AND id = ${id} AND status = 'active'
    `;
  }
}
