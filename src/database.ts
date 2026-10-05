import { DatabaseSync } from "node:sqlite";

/**
 * 打开（必要时创建）SQLite 数据库并保证表结构存在。
 * 同一进程内允许多个实例指向同一文件。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  // 需求只要求正常关闭与重启后的持久性，不要求崩溃恢复，故放宽为 NORMAL
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      cookies INTEGER NOT NULL,
      email_marketing INTEGER NOT NULL,
      data_sharing INTEGER NOT NULL,
      personalization INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consent_events (
      user_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      touched_categories TEXT NOT NULL,
      choices_after TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (user_id, revision)
    );
    CREATE TABLE IF NOT EXISTS event_categories (
      user_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      category TEXT NOT NULL,
      PRIMARY KEY (user_id, category, revision)
    );
    CREATE TABLE IF NOT EXISTS processed_requests (
      user_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY (user_id, request_id)
    );
  `);
  return db;
}
