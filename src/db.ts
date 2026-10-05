import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  initiator TEXT NOT NULL,
  field_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  current_layer INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS layers (
  instance_id TEXT NOT NULL,
  layer_index INTEGER NOT NULL,
  layer_type TEXT NOT NULL,
  PRIMARY KEY (instance_id, layer_index)
);
CREATE TABLE IF NOT EXISTS layer_approvers (
  instance_id TEXT NOT NULL,
  layer_index INTEGER NOT NULL,
  approver TEXT NOT NULL,
  PRIMARY KEY (instance_id, layer_index, approver)
);
CREATE TABLE IF NOT EXISTS consents (
  instance_id TEXT NOT NULL,
  layer_index INTEGER NOT NULL,
  approver TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, layer_index, approver)
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  layer_index INTEGER NOT NULL,
  assignee TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_assignee ON todos (assignee, status);
CREATE INDEX IF NOT EXISTS idx_todos_instance ON todos (instance_id, status);
`;

/** 打开（必要时创建）SQLite 数据库并初始化表结构。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
