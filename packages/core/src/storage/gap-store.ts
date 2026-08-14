import type { Sql } from './db.js';
import type {
  BomSnapshot,
  EvidenceLogRecord,
  EvidenceRecord,
  GapRowRecord,
  WaiverRecord,
} from '../gap/types.js';

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function rowToGapRow(row: any): GapRowRecord {
  const { project_id, ...rest } = row;
  return rest as GapRowRecord;
}

// ============================================================
// GapStore — gap 账本持久化（基准 / 差距行 / 证据 / 豁免）
// ============================================================

export class GapStore {
  constructor(private sql: Sql, private projectId: string) {}

  // ── 基准 ──────────────────────────────────────────────────

  async getBaseline(): Promise<{ bom_commit: string; bom: BomSnapshot; updated_at: string } | null> {
    const rows = await this.sql`
      SELECT * FROM gap_baseline WHERE project_id = ${this.projectId}
    `;
    if (rows.length === 0) return null;
    return {
      bom_commit: rows[0].bom_commit,
      bom: parseJson<BomSnapshot>(rows[0].bom),
      updated_at: rows[0].updated_at,
    };
  }

  async setBaseline(bom: BomSnapshot, updatedAt: string): Promise<void> {
    await this.sql`
      INSERT INTO gap_baseline (project_id, bom_commit, bom, updated_at)
      VALUES (${this.projectId}, ${bom.commit}, ${JSON.stringify(bom)}, ${updatedAt})
      ON CONFLICT (project_id) DO UPDATE SET
        bom_commit = excluded.bom_commit,
        bom = excluded.bom,
        updated_at = excluded.updated_at
    `;
  }

  // ── 证据 ──────────────────────────────────────────────────

  async upsertEvidence(record: EvidenceRecord): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO gap_evidence (project_id, source_id, payload, fingerprint, reported_at, baseline_commit)
        VALUES (${this.projectId}, ${record.source_id}, ${JSON.stringify(record.payload)},
                ${record.fingerprint}, ${record.reported_at}, ${record.baseline_commit ?? null})
        ON CONFLICT (project_id, source_id) DO UPDATE SET
          payload = excluded.payload,
          fingerprint = excluded.fingerprint,
          reported_at = excluded.reported_at,
          baseline_commit = excluded.baseline_commit
      `;
      await tx`
        INSERT INTO gap_evidence_log (project_id, source_id, payload, fingerprint, reported_at, baseline_commit, created_at)
        VALUES (${this.projectId}, ${record.source_id}, ${JSON.stringify(record.payload)},
                ${record.fingerprint}, ${record.reported_at}, ${record.baseline_commit ?? null},
                ${new Date().toISOString()})
      `;
    });
  }

  async getEvidence(sourceId: string): Promise<EvidenceRecord | null> {
    const rows = await this.sql`
      SELECT * FROM gap_evidence
      WHERE project_id = ${this.projectId} AND source_id = ${sourceId}
    `;
    if (rows.length === 0) return null;
    return {
      source_id: rows[0].source_id,
      payload: parseJson(rows[0].payload),
      fingerprint: rows[0].fingerprint,
      reported_at: rows[0].reported_at,
      baseline_commit: rows[0].baseline_commit ?? null,
    };
  }

  async getAllEvidence(): Promise<EvidenceRecord[]> {
    const rows = await this.sql`
      SELECT * FROM gap_evidence WHERE project_id = ${this.projectId}
    `;
    return rows.map(r => ({
      source_id: r.source_id,
      payload: parseJson(r.payload),
      fingerprint: r.fingerprint,
      reported_at: r.reported_at,
      baseline_commit: r.baseline_commit ?? null,
    }));
  }

  /** 证据上报留痕（append-only log，按 created_at 倒序） */
  async getEvidenceHistory(sourceId: string): Promise<EvidenceLogRecord[]> {
    const rows = await this.sql`
      SELECT id, source_id, payload, fingerprint, reported_at, baseline_commit, created_at
      FROM gap_evidence_log
      WHERE project_id = ${this.projectId} AND source_id = ${sourceId}
      ORDER BY created_at DESC
    `;
    return rows.map(r => ({
      id: Number(r.id),
      source_id: r.source_id,
      payload: parseJson(r.payload),
      fingerprint: r.fingerprint,
      reported_at: r.reported_at,
      baseline_commit: r.baseline_commit ?? null,
      created_at: r.created_at,
    }));
  }

  // ── 差距行 ────────────────────────────────────────────────

  async insertRow(row: GapRowRecord): Promise<void> {
    await this.sql`
      INSERT INTO gap_rows (id, project_id, requirement_key, kind, title, detail, severity,
                            source_ref, evidence_source, bom_commit, condition_fingerprint, evidence_fingerprint,
                            status, detected_at, resolved_at, superseded_at)
      VALUES (${row.id}, ${this.projectId}, ${row.requirement_key}, ${row.kind}, ${row.title},
              ${row.detail}, ${row.severity}, ${row.source_ref}, ${row.evidence_source}, ${row.bom_commit},
              ${row.condition_fingerprint}, ${row.evidence_fingerprint}, ${row.status},
              ${row.detected_at}, ${row.resolved_at}, ${row.superseded_at})
      ON CONFLICT (project_id, requirement_key, kind, evidence_source) WHERE status = 'open' DO NOTHING
    `;
  }

  async refreshRow(id: string, detail: string, evidenceFingerprint: string | null, detectedAt: string): Promise<void> {
    await this.sql`
      UPDATE gap_rows SET detail = ${detail}, evidence_fingerprint = ${evidenceFingerprint},
        detected_at = ${detectedAt}
      WHERE id = ${id} AND project_id = ${this.projectId}
    `;
  }

  async resolveRow(id: string, resolvedAt: string): Promise<void> {
    await this.sql`
      UPDATE gap_rows SET status = 'resolved', resolved_at = ${resolvedAt}
      WHERE id = ${id} AND project_id = ${this.projectId}
    `;
  }

  async supersedeRowsByKeys(keys: string[], supersededAt: string): Promise<void> {
    for (const key of keys) {
      await this.sql`
        UPDATE gap_rows SET status = 'superseded', superseded_at = ${supersededAt}
        WHERE project_id = ${this.projectId} AND status = 'open'
          AND requirement_key = ${key}
      `;
    }
  }

  async getOpenRows(): Promise<GapRowRecord[]> {
    const rows = await this.sql`
      SELECT * FROM gap_rows
      WHERE project_id = ${this.projectId} AND status = 'open'
      ORDER BY detected_at ASC
    `;
    return rows.map(rowToGapRow);
  }

  async getAllRows(): Promise<GapRowRecord[]> {
    const rows = await this.sql`
      SELECT * FROM gap_rows
      WHERE project_id = ${this.projectId}
      ORDER BY detected_at ASC
    `;
    return rows.map(rowToGapRow);
  }

  // ── 豁免 ──────────────────────────────────────────────────

  async upsertWaiver(record: WaiverRecord): Promise<void> {
    await this.sql`
      INSERT INTO gap_waivers (project_id, fingerprint, reason, expires_at, created_at)
      VALUES (${this.projectId}, ${record.fingerprint}, ${record.reason},
              ${record.expires_at}, ${record.created_at})
      ON CONFLICT (project_id, fingerprint) DO UPDATE SET
        reason = excluded.reason,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `;
  }

  async getWaivers(): Promise<WaiverRecord[]> {
    const rows = await this.sql`
      SELECT * FROM gap_waivers WHERE project_id = ${this.projectId}
    `;
    return rows.map(r => ({
      fingerprint: r.fingerprint,
      reason: r.reason,
      expires_at: r.expires_at,
      created_at: r.created_at,
    }));
  }
}
