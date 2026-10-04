import { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  recipient TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  critical INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  seq INTEGER NOT NULL,
  first_started_at INTEGER NOT NULL,
  call_ended INTEGER NOT NULL DEFAULT 0,
  call_ended_at INTEGER,
  UNIQUE (notification_id, seq)
);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
