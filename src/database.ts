import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  database TEXT NOT NULL,
  role TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_active
  ON grants(user, database, role) WHERE revoked = 0;

CREATE TABLE IF NOT EXISTS review_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL REFERENCES review_cycles(id),
  grant_id INTEGER NOT NULL REFERENCES grants(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'revoked')),
  decided_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_cycle_grant
  ON review_entries(cycle_id, grant_id);

CREATE INDEX IF NOT EXISTS idx_entries_grant
  ON review_entries(grant_id);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
