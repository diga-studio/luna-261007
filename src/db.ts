import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  role TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);
-- 同一 (user, database, role) 组合最多一个未撤销实例
CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_active_combo
  ON grants (user_id, database_id, role) WHERE revoked = 0;

CREATE TABLE IF NOT EXISTS review_cycles (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES review_cycles (id),
  grant_id TEXT NOT NULL REFERENCES grants (id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'revoked')),
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_cycle ON review_items (cycle_id);
CREATE INDEX IF NOT EXISTS idx_items_grant ON review_items (grant_id);

-- 服务级元数据（如上次见到的时钟值，用于单调性校验）
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

/** 打开（或创建）数据库并初始化 schema。传 ":memory:" 使用内存库。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
