import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES categories(id)
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  published INTEGER NOT NULL CHECK (published IN (0, 1))
);

CREATE TABLE IF NOT EXISTS article_categories (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  PRIMARY KEY (article_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_article_categories_category
  ON article_categories(category_id);
`;

/** 打开数据库并确保表结构存在。 */
export function openDatabase(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
