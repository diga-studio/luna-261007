import { DatabaseSync } from 'node:sqlite';
import type { ArticleInput, EdgeInput } from './types';

export class CmsDatabase {
  private db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY,
        rank INTEGER NOT NULL,
        published INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
    `);
  }

  load(articles: Iterable<ArticleInput>, edges: Iterable<EdgeInput>): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DROP TABLE IF EXISTS edges');
      this.db.exec('DROP TABLE IF EXISTS articles');
      this.createSchema();
      const insertArticle = this.db.prepare(
        'INSERT INTO articles (id, rank, published) VALUES (?, ?, ?)',
      );
      for (const article of articles) {
        insertArticle.run(article.id, article.rank, article.published ? 1 : 0);
      }
      const insertEdge = this.db.prepare(
        'INSERT INTO edges (from_id, to_id) VALUES (?, ?)',
      );
      for (const edge of edges) {
        insertEdge.run(edge.from, edge.to);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get connection(): DatabaseSync {
    return this.db;
  }
}
