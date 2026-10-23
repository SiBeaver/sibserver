import type { JsonbParam, Sql } from './db.js';
import type { ProposalKind, ProposalStatus, ProposalView } from '../workpack/types.js';

// ============================================================
// ProposalStore — 契约变更/重规划提案（运行时状态）
// ============================================================

export interface ProposalRecord {
  id: string;
  workpack_id: string | null;
  kind: ProposalKind;
  proposer: string;
  requirement_keys: string[];
  summary: string;
  detail: unknown;
  status: ProposalStatus;
  created_at: string;
  confirmed_commit: string | null;
  confirmed_by: string | null;
  resolved_at: string | null;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToProposal(row: Record<string, unknown>): ProposalRecord {
  return {
    id: String(row.id),
    workpack_id: optionalString(row.workpack_id),
    kind: row.kind as ProposalKind,
    proposer: String(row.proposer),
    requirement_keys: Array.isArray(row.requirement_keys) ? row.requirement_keys.map(String) : [],
    summary: String(row.summary),
    detail: parseJson<unknown>(row.detail),
    status: row.status as ProposalStatus,
    created_at: String(row.created_at),
    confirmed_commit: optionalString(row.confirmed_commit),
    confirmed_by: optionalString(row.confirmed_by),
    resolved_at: optionalString(row.resolved_at),
  };
}

export function toProposalView(record: ProposalRecord): ProposalView {
  return {
    id: record.id,
    workpack_id: record.workpack_id,
    kind: record.kind,
    proposer: record.proposer,
    requirement_keys: record.requirement_keys,
    summary: record.summary,
    detail: record.detail,
    status: record.status,
    created_at: record.created_at,
    confirmed_commit: record.confirmed_commit,
    confirmed_by: record.confirmed_by,
    resolved_at: record.resolved_at,
  };
}

export class ProposalStore {
  constructor(private sql: Sql, private projectId: string) {}

  async insertProposal(record: ProposalRecord): Promise<void> {
    await this.sql`
      INSERT INTO workpack_proposals
        (id, project_id, workpack_id, kind, proposer, requirement_keys, summary, detail,
         status, created_at, confirmed_commit, confirmed_by, resolved_at)
      VALUES
        (${record.id}, ${this.projectId}, ${record.workpack_id}, ${record.kind},
         ${record.proposer}, ${record.requirement_keys}, ${record.summary},
         ${this.sql.json(record.detail as JsonbParam)},
         ${record.status}, ${record.created_at}, ${record.confirmed_commit},
         ${record.confirmed_by}, ${record.resolved_at})
    `;
  }

  async getProposal(id: string): Promise<ProposalRecord | null> {
    const rows = await this.sql`
      SELECT * FROM workpack_proposals
      WHERE project_id = ${this.projectId} AND id = ${id}
    `;
    return rows.length > 0 ? rowToProposal(rows[0] as Record<string, unknown>) : null;
  }

  async listProposals(status?: ProposalStatus): Promise<ProposalRecord[]> {
    const rows = status
      ? await this.sql`
          SELECT * FROM workpack_proposals
          WHERE project_id = ${this.projectId} AND status = ${status}
          ORDER BY created_at ASC
        `
      : await this.sql`
          SELECT * FROM workpack_proposals
          WHERE project_id = ${this.projectId}
          ORDER BY created_at ASC
        `;
    return rows.map(row => rowToProposal(row as Record<string, unknown>));
  }

  /** 契约提案：基线前移且目标需求键变化 = 人确认（commit 即确认） */
  async confirmByChangedKeys(commit: string, keys: string[], now: string): Promise<number> {
    if (keys.length === 0) return 0;
    const rows = await this.sql`
      UPDATE workpack_proposals
      SET status = 'confirmed', confirmed_commit = ${commit}, resolved_at = ${now}
      WHERE project_id = ${this.projectId}
        AND kind = 'contract'
        AND status = 'proposed'
        AND requirement_keys && ${keys}
      RETURNING id
    `;
    return rows.length;
  }

  /** 重规划提案：由人显式接受（服务端不应用提案内容） */
  async confirmReplan(id: string, confirmedBy: string, now: string): Promise<void> {
    await this.sql`
      UPDATE workpack_proposals
      SET status = 'confirmed', confirmed_by = ${confirmedBy}, resolved_at = ${now}
      WHERE project_id = ${this.projectId}
        AND id = ${id}
        AND kind = 'replan'
        AND status = 'proposed'
    `;
  }
}
