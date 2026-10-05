import { DatabaseSync } from 'node:sqlite';

/**
 * Open (or create) the metadata database and ensure the schema exists.
 *
 * Tables:
 * - meta: singleton key/value, holds baseline_version (starts at 0).
 * - baseline: current published baseline, name -> image id.
 * - runs: one row per submitted run; id doubles as submission order.
 * - run_images: screenshots of a run, the pinned baseline image used, and the outcome.
 * - images: every stored image id (file content lives on disk).
 */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS baseline (
      name TEXT PRIMARY KEY,
      image_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
      passed INTEGER,
      baseline_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_images (
      run_id INTEGER NOT NULL REFERENCES runs(id),
      name TEXT NOT NULL,
      image_id TEXT NOT NULL,
      baseline_image_id TEXT,
      match_rate REAL,
      passed INTEGER,
      PRIMARY KEY (run_id, name)
    );
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY
    );
  `);
  db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('baseline_version', '0')`).run();
  return db;
}
