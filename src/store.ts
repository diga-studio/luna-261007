import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface StoredPoint {
  pingId: string;
  ts: number;
  lat: number;
  lon: number;
}

interface PointRow {
  ping_id: string;
  ts: number;
  lat: number;
  lon: number;
}

/** SQLite persistence layer: winning points per (employee, device, ts) and daily aggregates. */
export class Store {
  private db: DatabaseSync;
  private stmtGetPoint: StatementSync;
  private stmtGetPrev: StatementSync;
  private stmtGetNext: StatementSync;
  private stmtUpsert: StatementSync;
  private stmtAddDaily: StatementSync;
  private stmtGetDaily: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS points (
        employee_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ping_id TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        PRIMARY KEY (employee_id, device_id, ts)
      );
      CREATE TABLE IF NOT EXISTS daily (
        employee_id TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        meters REAL NOT NULL,
        PRIMARY KEY (employee_id, day_start)
      );
    `);
    this.stmtGetPoint = this.db.prepare(
      "SELECT ping_id, ts, lat, lon FROM points WHERE employee_id = ? AND device_id = ? AND ts = ?",
    );
    this.stmtGetPrev = this.db.prepare(
      "SELECT ping_id, ts, lat, lon FROM points WHERE employee_id = ? AND device_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1",
    );
    this.stmtGetNext = this.db.prepare(
      "SELECT ping_id, ts, lat, lon FROM points WHERE employee_id = ? AND device_id = ? AND ts > ? ORDER BY ts ASC LIMIT 1",
    );
    this.stmtUpsert = this.db.prepare(
      "INSERT OR REPLACE INTO points (employee_id, device_id, ts, ping_id, lat, lon) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtAddDaily = this.db.prepare(
      `INSERT INTO daily (employee_id, day_start, meters) VALUES (?, ?, ?)
       ON CONFLICT (employee_id, day_start) DO UPDATE SET meters = meters + excluded.meters`,
    );
    this.stmtGetDaily = this.db.prepare(
      "SELECT meters FROM daily WHERE employee_id = ? AND day_start = ?",
    );
  }

  begin(): void {
    this.db.exec("BEGIN");
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  private static toPoint(row: PointRow | undefined): StoredPoint | null {
    if (!row) return null;
    return { pingId: row.ping_id, ts: row.ts, lat: row.lat, lon: row.lon };
  }

  /** The currently winning point at exactly (employee, device, ts), if any. */
  getPoint(employeeId: string, deviceId: string, ts: number): StoredPoint | null {
    const row = this.stmtGetPoint.get(employeeId, deviceId, ts) as
      | PointRow
      | undefined;
    return Store.toPoint(row);
  }

  /** Strict predecessor of ts in the device's trajectory. */
  getPrev(employeeId: string, deviceId: string, ts: number): StoredPoint | null {
    const row = this.stmtGetPrev.get(employeeId, deviceId, ts) as
      | PointRow
      | undefined;
    return Store.toPoint(row);
  }

  /** Strict successor of ts in the device's trajectory. */
  getNext(employeeId: string, deviceId: string, ts: number): StoredPoint | null {
    const row = this.stmtGetNext.get(employeeId, deviceId, ts) as
      | PointRow
      | undefined;
    return Store.toPoint(row);
  }

  upsertPoint(employeeId: string, deviceId: string, p: StoredPoint): void {
    this.stmtUpsert.run(employeeId, deviceId, p.ts, p.pingId, p.lat, p.lon);
  }

  addDaily(employeeId: string, dayStartMs: number, deltaM: number): void {
    this.stmtAddDaily.run(employeeId, dayStartMs, deltaM);
  }

  getDaily(employeeId: string, dayStartMs: number): number {
    const row = this.stmtGetDaily.get(employeeId, dayStartMs) as
      | { meters: number }
      | undefined;
    return row ? row.meters : 0;
  }

  close(): void {
    this.db.close();
  }
}
