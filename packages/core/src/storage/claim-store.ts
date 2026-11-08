import type { JsonbParam, Sql } from './db.js';
import type {
  BoundaryDeclaration,
  ClaimDomain,
  ClaimStatus,
  PreAuthorization,
  SessionRef,
} from '../claims/types.js';
import type { IsolationMode } from '../workpack/types.js';

// ============================================================
// ClaimStore — 责任认领租约（运行时状态，不进契约/认知图谱）
// 互斥按需求键逐一判定（r-wp3c）：claim_keys 活跃行上建唯一索引。
// ============================================================

export interface ResponsibilityClaimRecord {
  id: string;
  executor: string;
  requirement_keys: string[];
  domain: ClaimDomain;
  baseline_commit: string;
  boundary: BoundaryDeclaration;
  pre_authorization: PreAuthorization | null;
  isolation_mode: IsolationMode;
  isolation_id: string;
  session_ref: SessionRef | null;
  status: ClaimStatus;
  lease_expires_at: string;
  heartbeat_at: string;
  created_at: string;
  released_at: string | null;
  revoked_reason: string | null;
}

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function rowToClaim(row: Record<string, unknown>): ResponsibilityClaimRecord {
  return {
    id: String(row.id),
    executor: String(row.executor),
    requirement_keys: (row.requirement_keys as unknown[]).map(String),
    domain: row.domain as ClaimDomain,
    baseline_commit: String(row.baseline_commit),
    boundary: parseJson<BoundaryDeclaration>(row.boundary) as BoundaryDeclaration,
    pre_authorization: parseJson<PreAuthorization>(row.pre_authorization),
    isolation_mode: row.isolation_mode as IsolationMode,
    isolation_id: String(row.isolation_id),
    session_ref: parseJson<SessionRef>(row.session_ref),
    status: row.status as ClaimStatus,
    lease_expires_at: String(row.lease_expires_at),
    heartbeat_at: String(row.heartbeat_at),
    created_at: String(row.created_at),
    released_at: row.released_at === null || row.released_at === undefined ? null : String(row.released_at),
    revoked_reason: row.revoked_reason === null || row.revoked_reason === undefined ? null : String(row.revoked_reason),
  };
}

export class ClaimStore {
  constructor(private sql: Sql, private projectId: string) {}

  // @sibom r-ar2b — 租约到期即失效回收，失效认领保留痕迹
  async expireStale(now: string): Promise<number> {
    const rows = await this.sql`
      WITH expired AS (
        UPDATE claims SET status = 'expired', released_at = ${now}
        WHERE project_id = ${this.projectId} AND status = 'active' AND lease_expires_at <= ${now}
        RETURNING id
      )
      UPDATE claim_keys SET status = 'expired'
      WHERE project_id = ${this.projectId} AND status = 'active'
        AND claim_id IN (SELECT id FROM expired)
      RETURNING claim_id
    `;
    return rows.length;
  }

  async insertClaim(claim: ResponsibilityClaimRecord): Promise<void> {
    await this.sql`
      INSERT INTO claims
        (id, project_id, executor, requirement_keys, domain, baseline_commit, boundary, pre_authorization,
         isolation_mode, isolation_id, session_ref, status, lease_expires_at, heartbeat_at,
         created_at, released_at, revoked_reason)
      VALUES
        (${claim.id}, ${this.projectId}, ${claim.executor}, ${claim.requirement_keys},
         ${claim.domain}, ${claim.baseline_commit},
         ${this.sql.json(claim.boundary as unknown as JsonbParam)},
         ${claim.pre_authorization === null ? null : this.sql.json(claim.pre_authorization as unknown as JsonbParam)},
         ${claim.isolation_mode}, ${claim.isolation_id},
         ${claim.session_ref === null ? null : this.sql.json(claim.session_ref as unknown as JsonbParam)},
         ${claim.status}, ${claim.lease_expires_at}, ${claim.heartbeat_at},
         ${claim.created_at}, ${claim.released_at}, ${claim.revoked_reason})
    `;
    await this.sql`
      INSERT INTO claim_keys (project_id, claim_id, requirement_key, status)
      SELECT ${this.projectId}, ${claim.id}, key, 'active'
      FROM unnest(${claim.requirement_keys}::text[]) AS key
    `;
  }

  async getActiveClaims(): Promise<ResponsibilityClaimRecord[]> {
    const rows = await this.sql`
      SELECT * FROM claims
      WHERE project_id = ${this.projectId} AND status = 'active'
      ORDER BY created_at ASC
    `;
    return rows.map(row => rowToClaim(row as Record<string, unknown>));
  }

  async getClaim(id: string): Promise<ResponsibilityClaimRecord | null> {
    const rows = await this.sql`
      SELECT * FROM claims WHERE project_id = ${this.projectId} AND id = ${id} LIMIT 1
    `;
    return rows.length > 0 ? rowToClaim(rows[0] as Record<string, unknown>) : null;
  }

  async getActiveClaim(id: string): Promise<ResponsibilityClaimRecord | null> {
    const rows = await this.sql`
      SELECT * FROM claims
      WHERE project_id = ${this.projectId} AND id = ${id} AND status = 'active'
      LIMIT 1
    `;
    return rows.length > 0 ? rowToClaim(rows[0] as Record<string, unknown>) : null;
  }

  async listClaims(status?: ClaimStatus): Promise<ResponsibilityClaimRecord[]> {
    const rows = status
      ? await this.sql`
          SELECT * FROM claims WHERE project_id = ${this.projectId} AND status = ${status}
          ORDER BY created_at DESC
        `
      : await this.sql`
          SELECT * FROM claims WHERE project_id = ${this.projectId}
          ORDER BY created_at DESC
        `;
    return rows.map(row => rowToClaim(row as Record<string, unknown>));
  }

  async updateLease(id: string, leaseExpiresAt: string, heartbeatAt: string): Promise<void> {
    await this.sql`
      UPDATE claims
      SET lease_expires_at = ${leaseExpiresAt}, heartbeat_at = ${heartbeatAt}
      WHERE project_id = ${this.projectId} AND id = ${id} AND status = 'active'
    `;
  }

  async updateBoundary(id: string, boundary: BoundaryDeclaration): Promise<void> {
    await this.sql`
      UPDATE claims
      SET boundary = ${this.sql.json(boundary as unknown as JsonbParam)}
      WHERE project_id = ${this.projectId} AND id = ${id} AND status = 'active'
    `;
  }

  async closeClaim(
    id: string,
    status: Exclude<ClaimStatus, 'active'>,
    releasedAt: string,
    revokedReason: string | null = null,
  ): Promise<void> {
    await this.sql`
      UPDATE claims
      SET status = ${status}, released_at = ${releasedAt}, revoked_reason = ${revokedReason}
      WHERE project_id = ${this.projectId} AND id = ${id} AND status = 'active'
    `;
    await this.sql`
      UPDATE claim_keys SET status = ${status}
      WHERE project_id = ${this.projectId} AND claim_id = ${id} AND status = 'active'
    `;
  }
}
