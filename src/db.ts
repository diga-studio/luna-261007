import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  quals TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id);
CREATE TABLE IF NOT EXISTS gaps (
  id TEXT PRIMARY KEY,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  required_quals TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  gap_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_min INTEGER NOT NULL,
  deadline_min INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);
CREATE INDEX IF NOT EXISTS idx_invitations_employee ON invitations(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_gap ON invitations(gap_id, status);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  params TEXT NOT NULL,
  response TEXT NOT NULL
);
`;

/** 打开（必要时创建）数据库文件并保证表结构存在。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
