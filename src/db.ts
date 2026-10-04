import { DatabaseSync } from 'node:sqlite';
import type { Article, Edge, PageArgs } from './types';

export interface ArticleRow {
  id: number;
  rank: number;
}

const DEFAULT_OFFSET = 0;
const DEFAULT_LIMIT = 20;

export class CmsDatabase {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE articles (
        id INTEGER PRIMARY KEY,
        rank INTEGER NOT NULL,
        published INTEGER NOT NULL
      );
      CREATE TABLE edges (
        source INTEGER NOT NULL,
        target INTEGER NOT NULL
      );
      CREATE INDEX idx_articles_page ON articles (published, rank, id);
      CREATE INDEX idx_edges_source ON edges (source, target);
    `);
  }

  load(articles: Iterable<Article>, edges: Iterable<Edge>): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM edges; DELETE FROM articles;');
      const insertArticle = this.db.prepare(
        'INSERT INTO articles (id, rank, published) VALUES (?, ?, ?)',
      );
      for (const article of articles) {
        insertArticle.run(
          article.id,
          article.rank,
          article.published ? 1 : 0,
        );
      }
      const insertEdge = this.db.prepare(
        'INSERT INTO edges (source, target) VALUES (?, ?)',
      );
      for (const edge of edges) {
        insertEdge.run(edge.source, edge.target);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  queryArticles(args: PageArgs): ArticleRow[] {
    const stmt = this.db.prepare(
      `SELECT id, rank FROM articles
       WHERE published = 1
       ORDER BY rank ASC, id ASC
       LIMIT ? OFFSET ?`,
    );
    return stmt.all(
      normalizeLimit(args.limit),
      normalizeOffset(args.offset),
    ) as unknown as ArticleRow[];
  }

  queryRelated(sourceId: number, args: PageArgs): ArticleRow[] {
    const stmt = this.db.prepare(
      `SELECT a.id AS id, a.rank AS rank FROM articles a
       JOIN edges e ON e.target = a.id
       WHERE e.source = ? AND a.published = 1
       ORDER BY a.rank ASC, a.id ASC
       LIMIT ? OFFSET ?`,
    );
    return stmt.all(
      sourceId,
      normalizeLimit(args.limit),
      normalizeOffset(args.offset),
    ) as unknown as ArticleRow[];
  }

  close(): void {
    this.db.close();
  }
}

function normalizeOffset(offset: number | null | undefined): number {
  return offset ?? DEFAULT_OFFSET;
}

function normalizeLimit(limit: number | null | undefined): number {
  return limit ?? DEFAULT_LIMIT;
}
