import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  initiator TEXT NOT NULL,
  field_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS layers (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignees (
  id TEXT PRIMARY KEY,
  layer_id TEXT NOT NULL,
  person TEXT NOT NULL,
  active INTEGER NOT NULL,
  decision TEXT,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  assignee TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layers_instance ON layers(instance_id);
CREATE INDEX IF NOT EXISTS idx_assignees_layer ON assignees(layer_id);
CREATE INDEX IF NOT EXISTS idx_todos_assignee ON todos(assignee, status);
CREATE INDEX IF NOT EXISTS idx_todos_layer ON todos(layer_id);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
