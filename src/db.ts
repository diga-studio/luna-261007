import { DatabaseSync } from 'node:sqlite';

/** 打开（或创建）SQLite 数据库并初始化表结构 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      first_due_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      frequency TEXT NOT NULL CHECK (frequency IN ('once','monthly','quarterly','yearly'))
    );
    CREATE INDEX IF NOT EXISTS idx_rules_contract ON rules(contract_id);
    CREATE TABLE IF NOT EXISTS outcomes (
      rule_id INTEGER NOT NULL REFERENCES rules(id),
      due_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed','waived')),
      completed_date TEXT,
      PRIMARY KEY (rule_id, due_date)
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_due ON outcomes(due_date);
  `);
  return db;
}
