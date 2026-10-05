import { DatabaseSync } from "node:sqlite";
import type { ApplicationRevision, AdvancementRevision } from "./types.js";

interface ApplicationRow {
  id: string;
  loan_id: string;
  revision: number;
  complete_at: number;
  terminated_at: number | null;
  voided: number;
}

interface AdvancementRow {
  id: string;
  loan_id: string;
  revision: number;
  occurred_at: number;
  voided: number;
}

/**
 * SQLite 持久化层。
 * 每个编号只保留最高修订号；较旧或相同修订号的重复投递直接忽略，
 * 作废（墓碑）同样占用修订号，迟到的旧版本无法复活记录。
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        loan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        complete_at INTEGER NOT NULL,
        terminated_at INTEGER,
        voided INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS advancements (
        id TEXT PRIMARY KEY,
        loan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        voided INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_applications_loan ON applications (loan_id);
      CREATE INDEX IF NOT EXISTS idx_advancements_loan ON advancements (loan_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertApplications(batch: ApplicationRevision[]): void {
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO applications (id, loan_id, revision, complete_at, terminated_at, voided)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          loan_id = excluded.loan_id,
          revision = excluded.revision,
          complete_at = excluded.complete_at,
          terminated_at = excluded.terminated_at,
          voided = excluded.voided
        WHERE excluded.revision > applications.revision
      `);
      for (const app of batch) {
        stmt.run(app.id, app.loanId, app.revision, app.completeAt, app.terminatedAt, app.voided ? 1 : 0);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  upsertAdvancements(batch: AdvancementRevision[]): void {
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO advancements (id, loan_id, revision, occurred_at, voided)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          loan_id = excluded.loan_id,
          revision = excluded.revision,
          occurred_at = excluded.occurred_at,
          voided = excluded.voided
        WHERE excluded.revision > advancements.revision
      `);
      for (const adv of batch) {
        stmt.run(adv.id, adv.loanId, adv.revision, adv.occurredAt, adv.voided ? 1 : 0);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getApplication(id: string): ApplicationRevision | null {
    const row = this.db
      .prepare("SELECT * FROM applications WHERE id = ?")
      .get(id) as ApplicationRow | undefined;
    return row === undefined ? null : toApplication(row);
  }

  getAdvancement(id: string): AdvancementRevision | null {
    const row = this.db
      .prepare("SELECT * FROM advancements WHERE id = ?")
      .get(id) as AdvancementRow | undefined;
    return row === undefined ? null : toAdvancement(row);
  }

  /** 某贷款下所有当前有效（未作废）申请 */
  listActiveApplicationsByLoan(loanId: string): ApplicationRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM applications WHERE loan_id = ? AND voided = 0")
      .all(loanId) as unknown as ApplicationRow[];
    return rows.map(toApplication);
  }
}

function toApplication(row: ApplicationRow): ApplicationRevision {
  return {
    id: row.id,
    loanId: row.loan_id,
    revision: row.revision,
    completeAt: row.complete_at,
    terminatedAt: row.terminated_at,
    voided: row.voided !== 0,
  };
}

function toAdvancement(row: AdvancementRow): AdvancementRevision {
  return {
    id: row.id,
    loanId: row.loan_id,
    revision: row.revision,
    occurredAt: row.occurred_at,
    voided: row.voided !== 0,
  };
}
