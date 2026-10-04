import { DatabaseSync } from 'node:sqlite';
import type { MetricRecord } from './types.js';

export interface ArchiveRow {
  id: number;
  startHour: number;
  endHour: number;
  file: string;
  state: 'active' | 'obsolete';
}

interface MetricRow {
  resource: string;
  hour: number;
  revision: number;
  cpu: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hot (
  resource TEXT NOT NULL,
  hour INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  cpu INTEGER NOT NULL,
  PRIMARY KEY (resource, hour)
);
CREATE TABLE IF NOT EXISTS cold_delta (
  resource TEXT NOT NULL,
  hour INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  cpu INTEGER NOT NULL,
  PRIMARY KEY (resource, hour)
);
CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_hour INTEGER NOT NULL,
  end_hour INTEGER NOT NULL,
  file TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'obsolete'))
);
CREATE INDEX IF NOT EXISTS idx_hot_hour ON hot (hour);
CREATE INDEX IF NOT EXISTS idx_cold_delta_hour ON cold_delta (hour);
CREATE INDEX IF NOT EXISTS idx_archives_range ON archives (state, start_hour, end_hour);
`;

const UPSERT_HOT = `
INSERT INTO hot (resource, hour, revision, cpu) VALUES (?, ?, ?, ?)
ON CONFLICT (resource, hour) DO UPDATE SET
  revision = excluded.revision, cpu = excluded.cpu
  WHERE excluded.revision > hot.revision
`;

const UPSERT_COLD_DELTA = `
INSERT INTO cold_delta (resource, hour, revision, cpu) VALUES (?, ?, ?, ?)
ON CONFLICT (resource, hour) DO UPDATE SET
  revision = excluded.revision, cpu = excluded.cpu
  WHERE excluded.revision > cold_delta.revision
`;

function toRecord(row: unknown): MetricRecord {
  const r = row as MetricRow;
  return { resource: r.resource, hour: Number(r.hour), revision: Number(r.revision), cpu: Number(r.cpu) };
}

/** Owns the SQLite database: metadata, hot metrics, cold corrections, archive registry. */
export class MetricsDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Runs fn inside a single immediate transaction; rolls back on any throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get currentHour(): number | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'current_hour'`).get() as
      | { value: string }
      | undefined;
    return row === undefined ? null : Number(row.value);
  }

  setCurrentHour(hour: number): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('current_hour', ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(String(hour));
  }

  upsertHot(records: MetricRecord[]): void {
    const stmt = this.db.prepare(UPSERT_HOT);
    for (const r of records) stmt.run(r.resource, r.hour, r.revision, r.cpu);
  }

  upsertColdDelta(records: MetricRecord[]): void {
    const stmt = this.db.prepare(UPSERT_COLD_DELTA);
    for (const r of records) stmt.run(r.resource, r.hour, r.revision, r.cpu);
  }

  selectHot(resource: string, fromHour: number, toHour: number): MetricRecord[] {
    const rows = this.db
      .prepare('SELECT resource, hour, revision, cpu FROM hot WHERE resource = ? AND hour >= ? AND hour < ?')
      .all(resource, fromHour, toHour);
    return rows.map(toRecord);
  }

  selectColdDelta(resource: string, fromHour: number, toHour: number): MetricRecord[] {
    const rows = this.db
      .prepare('SELECT resource, hour, revision, cpu FROM cold_delta WHERE resource = ? AND hour >= ? AND hour < ?')
      .all(resource, fromHour, toHour);
    return rows.map(toRecord);
  }

  /** All hot rows with hour in [fromHour, toHour), any resource. */
  selectHotRange(fromHour: number, toHour: number): MetricRecord[] {
    const rows = this.db
      .prepare('SELECT resource, hour, revision, cpu FROM hot WHERE hour >= ? AND hour < ?')
      .all(fromHour, toHour);
    return rows.map(toRecord);
  }

  selectColdDeltaRange(fromHour: number, toHour: number): MetricRecord[] {
    const rows = this.db
      .prepare('SELECT resource, hour, revision, cpu FROM cold_delta WHERE hour >= ? AND hour < ?')
      .all(fromHour, toHour);
    return rows.map(toRecord);
  }

  deleteHotRange(fromHour: number, toHour: number): void {
    this.db.prepare('DELETE FROM hot WHERE hour >= ? AND hour < ?').run(fromHour, toHour);
  }

  deleteColdDeltaRange(fromHour: number, toHour: number): void {
    this.db.prepare('DELETE FROM cold_delta WHERE hour >= ? AND hour < ?').run(fromHour, toHour);
  }

  deleteHotBefore(hour: number): void {
    this.db.prepare('DELETE FROM hot WHERE hour < ?').run(hour);
  }

  deleteColdDeltaBefore(hour: number): void {
    this.db.prepare('DELETE FROM cold_delta WHERE hour < ?').run(hour);
  }

  insertArchive(startHour: number, endHour: number, file: string): number {
    const res = this.db
      .prepare(`INSERT INTO archives (start_hour, end_hour, file, state) VALUES (?, ?, ?, 'active')`)
      .run(startHour, endHour, file);
    return Number(res.lastInsertRowid);
  }

  markArchiveObsolete(id: number): void {
    this.db.prepare(`UPDATE archives SET state = 'obsolete' WHERE id = ?`).run(id);
  }

  deleteArchiveRow(id: number): void {
    this.db.prepare('DELETE FROM archives WHERE id = ?').run(id);
  }

  listArchives(state?: 'active' | 'obsolete'): ArchiveRow[] {
    const rows =
      state === undefined
        ? this.db.prepare('SELECT * FROM archives').all()
        : this.db.prepare('SELECT * FROM archives WHERE state = ?').all(state);
    return rows.map((row) => {
      const r = row as { id: number; start_hour: number; end_hour: number; file: string; state: string };
      return {
        id: Number(r.id),
        startHour: Number(r.start_hour),
        endHour: Number(r.end_hour),
        file: r.file,
        state: r.state as 'active' | 'obsolete',
      };
    });
  }

  /** Active archives whose [start,end) overlaps [fromHour, toHour). */
  activeArchivesOverlapping(fromHour: number, toHour: number): ArchiveRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM archives WHERE state = 'active' AND start_hour < ? AND end_hour > ? ORDER BY start_hour`,
      )
      .all(toHour, fromHour);
    return rows.map((row) => {
      const r = row as { id: number; start_hour: number; end_hour: number; file: string; state: string };
      return {
        id: Number(r.id),
        startHour: Number(r.start_hour),
        endHour: Number(r.end_hour),
        file: r.file,
        state: 'active' as const,
      };
    });
  }
}
