import { DatabaseSync } from "node:sqlite";
import { PipelineDefinition, RunRecord, RunStatus } from "./types";

interface RunRow {
  id: string;
  seq: number;
  status: string;
  definition: string;
  logDir: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentStage: number | null;
  currentStep: number | null;
  detail: string | null;
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    seq: row.seq,
    status: row.status as RunStatus,
    definition: JSON.parse(row.definition) as PipelineDefinition,
    logDir: row.logDir,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    currentStage: row.currentStage,
    currentStep: row.currentStep,
    detail: row.detail,
  };
}

/** SQLite-backed persistence for run records. */
export class RunStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL,
        definition TEXT NOT NULL,
        logDir TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        finishedAt TEXT,
        currentStage INTEGER,
        currentStep INTEGER,
        detail TEXT
      )
    `);
  }

  insert(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, seq, status, definition, logDir, createdAt, startedAt, finishedAt, currentStage, currentStep, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.seq,
        record.status,
        JSON.stringify(record.definition),
        record.logDir,
        record.createdAt,
        record.startedAt,
        record.finishedAt,
        record.currentStage,
        record.currentStep,
        record.detail
      );
  }

  nextSeq(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runs`).get() as { seq: number };
    return row.seq;
  }

  get(id: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Atomic compare-and-set on status: only transitions when the current
   * status is one of `from`. Returns true when the row was updated.
   */
  updateStatus(
    id: string,
    from: RunStatus[],
    to: RunStatus,
    fields?: Partial<Pick<RunRecord, "startedAt" | "finishedAt" | "currentStage" | "currentStep" | "detail">>
  ): boolean {
    const sets: string[] = ["status = ?"];
    const params: (string | number | null)[] = [to];
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        sets.push(`${key} = ?`);
        params.push(value as string | number | null);
      }
    }
    const placeholders = from.map(() => "?").join(", ");
    params.push(id, ...from);
    const result = this.db
      .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
      .run(...params);
    return result.changes > 0;
  }

  updateProgress(id: string, stage: number | null, step: number | null): void {
    this.db
      .prepare(`UPDATE runs SET currentStage = ?, currentStep = ? WHERE id = ?`)
      .run(stage, step, id);
  }

  /** Queued runs in submission order. */
  listQueued(): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status = 'Queued' ORDER BY seq ASC`)
      .all() as unknown as RunRow[];
    return rows.map(rowToRecord);
  }

  close(): void {
    this.db.close();
  }
}
