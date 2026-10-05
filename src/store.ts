import { DatabaseSync } from "node:sqlite";
import type { Command } from "./types.js";

/** 当前有效的申请记录（最高修订号版本）。 */
export interface EffectiveApplication {
  readonly applicationId: string;
  readonly loanId: string;
  readonly revision: number;
  readonly voided: boolean;
  readonly completeAt: number | null;
  readonly terminatedAt: number | null;
}

/** 当前有效的推进记录（最高修订号版本）。 */
export interface EffectiveAdvancement {
  readonly advancementId: string;
  readonly loanId: string;
  readonly revision: number;
  readonly voided: boolean;
  readonly occurredAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  loan_id     TEXT,
  voided      INTEGER NOT NULL,
  facts       TEXT,
  PRIMARY KEY (entity_type, entity_id, revision)
);
`;

interface Row {
  entity_id: string;
  loan_id: string | null;
  revision: number;
  voided: number;
  facts: string | null;
}

/** SQLite 持久化层：保存全部修订版本，提供当前有效记录视图。 */
export class Store {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  /** 批量应用命令；只接受更高修订号，忽略较旧或相同版本。 */
  applyBatch(commands: readonly Command[]): void {
    this.db.exec("BEGIN");
    try {
      for (const command of commands) {
        this.applyOne(command);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyOne(command: Command): void {
    const entityType = command.kind.endsWith("application")
      ? "application"
      : "advancement";
    const entityId =
      "applicationId" in command ? command.applicationId : command.advancementId;
    const current = this.db
      .prepare(
        `SELECT MAX(revision) AS maxRev FROM records
         WHERE entity_type = ? AND entity_id = ?`,
      )
      .get(entityType, entityId) as { maxRev: number | null };
    if (current.maxRev !== null && command.revision <= current.maxRev) {
      return; // 较旧或相同版本：不改变结果
    }
    const voided = command.kind.startsWith("void");
    // 作废命令不携带贷款归属；沿用既有版本的贷款归属（贷款归属固定）。
    let loanId = "loanId" in command ? command.loanId : null;
    if (loanId === null) {
      const prior = this.db
        .prepare(
          `SELECT loan_id FROM records
           WHERE entity_type = ? AND entity_id = ? AND loan_id IS NOT NULL
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(entityType, entityId) as { loan_id: string } | undefined;
      loanId = prior?.loan_id ?? null;
    }
    const facts = "facts" in command ? JSON.stringify(command.facts) : null;
    this.db
      .prepare(
        `INSERT INTO records (entity_type, entity_id, revision, loan_id, voided, facts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entityType, entityId, command.revision, loanId, voided ? 1 : 0, facts);
  }

  private effectiveRows(entityType: string, loanId?: string): Row[] {
    const sql = `
      SELECT r.entity_id, r.loan_id, r.revision, r.voided, r.facts
      FROM records r
      JOIN (
        SELECT entity_id, MAX(revision) AS maxRev
        FROM records WHERE entity_type = ?
        GROUP BY entity_id
      ) m ON m.entity_id = r.entity_id AND m.maxRev = r.revision
      WHERE r.entity_type = ?
      ${loanId === undefined ? "" : "AND r.loan_id = ?"}
      ORDER BY r.entity_id`;
    const stmt = this.db.prepare(sql);
    return (loanId === undefined
      ? stmt.all(entityType, entityType)
      : stmt.all(entityType, entityType, loanId)) as unknown as Row[];
  }

  listEffectiveApplications(loanId?: string): EffectiveApplication[] {
    return this.effectiveRows("application", loanId).map((row) => {
      const facts = row.facts
        ? (JSON.parse(row.facts) as { completeAt: number; terminatedAt: number | null })
        : null;
      return {
        applicationId: row.entity_id,
        loanId: row.loan_id ?? "",
        revision: row.revision,
        voided: row.voided === 1,
        completeAt: facts?.completeAt ?? null,
        terminatedAt: facts?.terminatedAt ?? null,
      };
    });
  }

  listEffectiveAdvancements(loanId?: string): EffectiveAdvancement[] {
    return this.effectiveRows("advancement", loanId).map((row) => {
      const facts = row.facts
        ? (JSON.parse(row.facts) as { occurredAt: number })
        : null;
      return {
        advancementId: row.entity_id,
        loanId: row.loan_id ?? "",
        revision: row.revision,
        voided: row.voided === 1,
        occurredAt: facts?.occurredAt ?? null,
      };
    });
  }

  getAdvancement(advancementId: string): EffectiveAdvancement | null {
    const row = this.db
      .prepare(
        `SELECT entity_id, loan_id, revision, voided, facts
         FROM records
         WHERE entity_type = 'advancement' AND entity_id = ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(advancementId) as unknown as Row | undefined;
    if (!row) return null;
    const facts = row.facts
      ? (JSON.parse(row.facts) as { occurredAt: number })
      : null;
    return {
      advancementId: row.entity_id,
      loanId: row.loan_id ?? "",
      revision: row.revision,
      voided: row.voided === 1,
      occurredAt: facts?.occurredAt ?? null,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
