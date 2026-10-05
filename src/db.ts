import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invitations (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL,
  opening_id       TEXT NOT NULL,
  employee_id      TEXT NOT NULL,
  start_minute     INTEGER NOT NULL,
  end_minute       INTEGER NOT NULL,
  status           TEXT NOT NULL,
  created_minute   INTEGER NOT NULL,
  deadline_minute  INTEGER NOT NULL,
  updated_minute   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);
CREATE INDEX IF NOT EXISTS idx_invitations_employee ON invitations(employee_id);
CREATE INDEX IF NOT EXISTS idx_invitations_opening ON invitations(opening_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,
  response     TEXT NOT NULL,
  created_minute INTEGER NOT NULL
);
`;

/** 打开（必要时创建）数据库并初始化 schema。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL 允许读写并发；busy_timeout 让多进程写冲突时等待而非立即失败。
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** 在 IMMEDIATE 写事务中执行 fn：BEGIN IMMEDIATE 立即获取写锁，保证多进程写串行。 */
export function inWriteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 忽略回滚错误，抛出原始异常
    }
    throw err;
  }
}
