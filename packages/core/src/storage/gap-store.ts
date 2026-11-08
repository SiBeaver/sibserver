import type { Sql, JsonbParam } from './db.js';
import { BomSnapshot } from '../gap/types.js';
import type {
  ConstraintSetRecord,
  EvidenceLogRecord,
  EvidenceRecord,
  GapRowRecord,
  GapStateRecord,
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
      // 归一化：旧快照里的 constraints 分区被剥除（约束集已独立版本化），draft_requirements 补缺省
      bom: BomSnapshot.parse(parseJson<unknown>(rows[0].bom)),
      updated_at: rows[0].updated_at,
    };
  }

  async setBaseline(bom: BomSnapshot, updatedAt: string): Promise<void> {
    await this.sql`
      INSERT INTO gap_baseline (project_id, bom_commit, bom, updated_at)
      VALUES (${this.projectId}, ${bom.commit}, ${this.sql.json(bom)}, ${updatedAt})
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
        VALUES (${this.projectId}, ${record.source_id}, ${tx.json(record.payload as JsonbParam)},
                ${record.fingerprint}, ${record.reported_at}, ${record.baseline_commit ?? null})
        ON CONFLICT (project_id, source_id) DO UPDATE SET
          payload = excluded.payload,
          fingerprint = excluded.fingerprint,
          reported_at = excluded.reported_at,
          baseline_commit = excluded.baseline_commit
      `;
      await tx`
        INSERT INTO gap_evidence_log (project_id, source_id, payload, fingerprint, reported_at, baseline_commit, created_at)
        VALUES (${this.projectId}, ${record.source_id}, ${tx.json(record.payload as JsonbParam)},
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

  // ── 约束集（独立版本化对账输入）───────────────────────────

  async getConstraintSet(setId: string): Promise<ConstraintSetRecord | null> {
    const rows = await this.sql`
      SELECT set_id, set_hash, constraints, created_at FROM gap_constraint_sets
      WHERE project_id = ${this.projectId} AND set_id = ${setId}
    `;
    if (rows.length === 0) return null;
    return {
      set_id: rows[0].set_id,
      set_hash: rows[0].set_hash,
      constraints: parseJson(rows[0].constraints),
      created_at: rows[0].created_at,
    };
  }

  async listConstraintSets(): Promise<ConstraintSetRecord[]> {
    const rows = await this.sql`
      SELECT set_id, set_hash, constraints, created_at FROM gap_constraint_sets
      WHERE project_id = ${this.projectId} ORDER BY created_at ASC
    `;
    return rows.map(r => ({
      set_id: r.set_id,
      set_hash: r.set_hash,
      constraints: parseJson(r.constraints),
      created_at: r.created_at,
    }));
  }

  async insertConstraintSet(record: ConstraintSetRecord): Promise<void> {
    await this.sql`
      INSERT INTO gap_constraint_sets (project_id, set_id, set_hash, constraints, created_at)
      VALUES (${this.projectId}, ${record.set_id}, ${record.set_hash},
              ${this.sql.json(record.constraints as JsonbParam)}, ${record.created_at})
      ON CONFLICT (project_id, set_id) DO NOTHING
    `;
  }

  async getGapState(): Promise<GapStateRecord | null> {
    const rows = await this.sql`
      SELECT last_constraint_set_id, last_constraint_set_hash, updated_at FROM gap_state
      WHERE project_id = ${this.projectId}
    `;
    if (rows.length === 0) return null;
    return {
      last_constraint_set_id: rows[0].last_constraint_set_id ?? null,
      last_constraint_set_hash: rows[0].last_constraint_set_hash ?? null,
      updated_at: rows[0].updated_at ?? null,
    };
  }

  async setGapState(state: GapStateRecord): Promise<void> {
    await this.sql`
      INSERT INTO gap_state (project_id, last_constraint_set_id, last_constraint_set_hash, updated_at)
      VALUES (${this.projectId}, ${state.last_constraint_set_id}, ${state.last_constraint_set_hash}, ${state.updated_at})
      ON CONFLICT (project_id) DO UPDATE SET
        last_constraint_set_id = excluded.last_constraint_set_id,
        last_constraint_set_hash = excluded.last_constraint_set_hash,
        updated_at = excluded.updated_at
    `;
  }

  // ── 差距行 ────────────────────────────────────────────────

  async insertRow(row: GapRowRecord): Promise<void> {
    await this.sql`
      INSERT INTO gap_rows (id, project_id, requirement_key, kind, title, detail, severity,
                            source_ref, evidence_source, bom_commit, constraint_set_id, constraint_set_hash,
                            condition_fingerprint, evidence_fingerprint,
                            status, detected_at, resolved_at, superseded_at)
      VALUES (${row.id}, ${this.projectId}, ${row.requirement_key}, ${row.kind}, ${row.title},
              ${row.detail}, ${row.severity}, ${row.source_ref}, ${row.evidence_source}, ${row.bom_commit},
              ${row.constraint_set_id}, ${row.constraint_set_hash},
              ${row.condition_fingerprint}, ${row.evidence_fingerprint}, ${row.status},
              ${row.detected_at}, ${row.resolved_at}, ${row.superseded_at})
      ON CONFLICT (project_id, requirement_key, kind, evidence_source) WHERE status = 'open' DO NOTHING
    `;
  }

  async refreshRow(
    id: string,
    detail: string,
    evidenceFingerprint: string | null,
    detectedAt: string,
    conditionFingerprint: string,
    constraintSetId: string | null,
    constraintSetHash: string | null,
  ): Promise<void> {
    await this.sql`
      UPDATE gap_rows SET detail = ${detail}, evidence_fingerprint = ${evidenceFingerprint},
        detected_at = ${detectedAt}, condition_fingerprint = ${conditionFingerprint},
        constraint_set_id = ${constraintSetId}, constraint_set_hash = ${constraintSetHash}
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
