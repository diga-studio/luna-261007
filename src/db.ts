import { DatabaseSync } from "node:sqlite";

/** 打开数据库并建表（幂等） */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT NULL REFERENCES categories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('published', 'unpublished'))
    );

    CREATE TABLE IF NOT EXISTS article_categories (
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL REFERENCES categories(id),
      PRIMARY KEY (article_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_article_categories_category ON article_categories(category_id);
  `);
  return db;
}
