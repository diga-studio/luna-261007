import { DatabaseSync } from 'node:sqlite';
import { MetricInput } from './types.js';

interface HotRow {
  resource: string;
  hour: number;
  revision: number;
  utilization: number;
}

/** SQLite-backed storage for hot metrics and archival metadata. */
export class HotStore {
  private db: DatabaseSync;
  private txDepth = 0;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hot (
        resource TEXT NOT NULL,
        hour INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        utilization INTEGER NOT NULL,
        PRIMARY KEY (resource, hour)
      );
      CREATE INDEX IF NOT EXISTS idx_hot_hour ON hot (hour);
      CREATE TABLE IF NOT EXISTS archives (
        window_start INTEGER PRIMARY KEY,
        file TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_delete (
        file TEXT PRIMARY KEY
      );
    `);
  }

  getT(): number | null {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 't'`)
      .get() as { value: number } | undefined;
    return row === undefined ? null : row.value;
  }

  setT(t: number): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('t', ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(t);
  }

  upsertBatch(records: MetricInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO hot (resource, hour, revision, utilization)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (resource, hour) DO UPDATE SET
        revision = excluded.revision,
        utilization = excluded.utilization
      WHERE excluded.revision > hot.revision
    `);
    this.transaction(() => {
      for (const r of records) {
        stmt.run(r.resource, r.hour, r.revision, r.utilization);
      }
    });
  }

  selectResource(resource: string, startHour: number, endHour: number): MetricInput[] {
    const rows = this.db
      .prepare(`SELECT resource, hour, revision, utilization FROM hot
                WHERE resource = ? AND hour >= ? AND hour < ?`)
      .all(resource, startHour, endHour) as unknown as HotRow[];
    return rows;
  }

  selectRange(startHour: number, endHour: number): MetricInput[] {
    const rows = this.db
      .prepare(`SELECT resource, hour, revision, utilization FROM hot
                WHERE hour >= ? AND hour < ?`)
      .all(startHour, endHour) as unknown as HotRow[];
    return rows;
  }

  deleteBefore(beforeHour: number): void {
    this.db.prepare(`DELETE FROM hot WHERE hour < ?`).run(beforeHour);
  }

  listArchives(): Array<{ windowStart: number; file: string }> {
    const rows = this.db
      .prepare(`SELECT window_start AS windowStart, file FROM archives ORDER BY window_start`)
      .all() as unknown as Array<{ windowStart: number; file: string }>;
    return rows;
  }

  getArchive(windowStart: number): string | null {
    const row = this.db
      .prepare(`SELECT file FROM archives WHERE window_start = ?`)
      .get(windowStart) as { file: string } | undefined;
    return row === undefined ? null : row.file;
  }

  putArchive(windowStart: number, file: string): void {
    this.db
      .prepare(`INSERT INTO archives (window_start, file) VALUES (?, ?)
                ON CONFLICT (window_start) DO UPDATE SET file = excluded.file`)
      .run(windowStart, file);
  }

  removeArchive(windowStart: number): void {
    this.db.prepare(`DELETE FROM archives WHERE window_start = ?`).run(windowStart);
  }

  addPendingDelete(file: string): void {
    this.db
      .prepare(`INSERT INTO pending_delete (file) VALUES (?) ON CONFLICT (file) DO NOTHING`)
      .run(file);
  }

  listPendingDeletes(): string[] {
    const rows = this.db.prepare(`SELECT file FROM pending_delete`).all() as unknown as Array<{
      file: string;
    }>;
    return rows.map((r) => r.file);
  }

  removePendingDelete(file: string): void {
    this.db.prepare(`DELETE FROM pending_delete WHERE file = ?`).run(file);
  }

  transaction<T>(fn: () => T): T {
    const outer = this.txDepth === 0;
    const sp = `sp_${this.txDepth}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      this.txDepth -= 1;
      this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${sp}`);
      if (!outer) {
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
