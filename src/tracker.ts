import { DatabaseSync } from "node:sqlite";
import { Ping } from "./types";
import { haversineMeters, splitDistanceByDay } from "./geo";

const MAX_ACCURACY_FEET = 100;
const MAX_GAP_MS = 30 * 60 * 1000;

interface TrackPoint {
  ts: number;
  lat: number;
  lon: number;
}

interface PointRow extends TrackPoint {
  ping_id: string;
}

/**
 * Incremental GPS daily-distance accounting backed by a SQLite file.
 *
 * State kept in SQLite:
 *  - seen(ping_id): every pingId ever ingested (duplicate filter).
 *  - points(employee_id, device_id, ts, ping_id, lat, lon): the current
 *    winning (lowest pingId) valid point per (employee, device, timestamp).
 *  - daily(employee_id, day, dist): accumulated distance in meters.
 *
 * Each new valid point only touches its immediate predecessor/successor in
 * the same (employee, device) trajectory: the old edge between the neighbors
 * is removed and the two new edges are added, so work per ping is O(log n)
 * regardless of history size.
 */
export class GpsTracker {
  private db: DatabaseSync;
  private stmtSeen;
  private stmtGetPoint;
  private stmtGetPred;
  private stmtGetSucc;
  private stmtDelPoint;
  private stmtInsPoint;
  private stmtAddDaily;
  private stmtGetDaily;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (
        ping_id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS points (
        employee_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ping_id TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        PRIMARY KEY (employee_id, device_id, ts)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daily (
        employee_id TEXT NOT NULL,
        day TEXT NOT NULL,
        dist REAL NOT NULL,
        PRIMARY KEY (employee_id, day)
      ) WITHOUT ROWID;
    `);
    this.stmtSeen = this.db.prepare(
      "INSERT OR IGNORE INTO seen (ping_id) VALUES (?)",
    );
    this.stmtGetPoint = this.db.prepare(
      "SELECT ts, ping_id, lat, lon FROM points WHERE employee_id = ? AND device_id = ? AND ts = ?",
    );
    this.stmtGetPred = this.db.prepare(
      "SELECT ts, lat, lon FROM points WHERE employee_id = ? AND device_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1",
    );
    this.stmtGetSucc = this.db.prepare(
      "SELECT ts, lat, lon FROM points WHERE employee_id = ? AND device_id = ? AND ts > ? ORDER BY ts ASC LIMIT 1",
    );
    this.stmtDelPoint = this.db.prepare(
      "DELETE FROM points WHERE employee_id = ? AND device_id = ? AND ts = ?",
    );
    this.stmtInsPoint = this.db.prepare(
      "INSERT INTO points (employee_id, device_id, ts, ping_id, lat, lon) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtAddDaily = this.db.prepare(
      `INSERT INTO daily (employee_id, day, dist) VALUES (?, ?, ?)
       ON CONFLICT (employee_id, day) DO UPDATE SET dist = dist + excluded.dist`,
    );
    this.stmtGetDaily = this.db.prepare(
      "SELECT dist FROM daily WHERE employee_id = ? AND day = ?",
    );
  }

  ingestBatch(pings: Ping[]): void {
    this.db.exec("BEGIN");
    try {
      for (const ping of pings) {
        this.ingestOne(ping);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private ingestOne(ping: Ping): void {
    const inserted = this.stmtSeen.run(ping.pingId);
    if (Number(inserted.changes) === 0) return; // duplicate pingId
    if (ping.accuracy > MAX_ACCURACY_FEET) return; // low precision: never used

    const { employeeId, deviceId, timestamp: ts } = ping;
    const existing = this.stmtGetPoint.get(employeeId, deviceId, ts) as
      | PointRow
      | undefined;
    // ASCII byte order == JS string order for ASCII-only pingIds.
    if (existing && existing.ping_id < ping.pingId) return; // loses dedup

    const pred = this.stmtGetPred.get(employeeId, deviceId, ts) as
      | TrackPoint
      | undefined;
    const succ = this.stmtGetSucc.get(employeeId, deviceId, ts) as
      | TrackPoint
      | undefined;

    if (existing) {
      // A smaller pingId replaces the previous point at this timestamp:
      // remove both of its edge contributions.
      this.applyEdge(employeeId, pred, existing, -1);
      this.applyEdge(employeeId, existing, succ, -1);
      this.stmtDelPoint.run(employeeId, deviceId, ts);
    } else {
      // Fresh timestamp: the direct neighbor edge disappears.
      this.applyEdge(employeeId, pred, succ, -1);
    }

    this.stmtInsPoint.run(
      employeeId,
      deviceId,
      ts,
      ping.pingId,
      ping.latitude,
      ping.longitude,
    );
    const point: TrackPoint = { ts, lat: ping.latitude, lon: ping.longitude };
    this.applyEdge(employeeId, pred, point, 1);
    this.applyEdge(employeeId, point, succ, 1);
  }

  private applyEdge(
    employeeId: string,
    a: TrackPoint | undefined,
    b: TrackPoint | undefined,
    sign: 1 | -1,
  ): void {
    if (!a || !b) return;
    if (b.ts - a.ts > MAX_GAP_MS) return;
    const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (dist === 0) return;
    for (const [day, share] of splitDistanceByDay(a.ts, b.ts, dist)) {
      this.stmtAddDaily.run(employeeId, day, sign * share);
    }
  }

  getDaily(employeeId: string, day: string): number {
    const row = this.stmtGetDaily.get(employeeId, day) as
      | { dist: number }
      | undefined;
    return row ? row.dist : 0;
  }

  close(): void {
    this.db.close();
  }
}

export function openTracker(dbPath: string): GpsTracker {
  return new GpsTracker(dbPath);
}
