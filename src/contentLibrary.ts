import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import {
  MAX_CATEGORY_DEPTH,
  MAX_DIRECT_CATEGORIES,
  type ArticleInput,
  type CategoryId,
  type ContentLibraryOptions,
} from "./types.js";

/** 统计某个分类覆盖的已发布文章数（自身及全部后代，文章去重）。 */
const COVERAGE_SQL = `
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM categories WHERE id = ?
  UNION ALL
  SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
)
SELECT COUNT(DISTINCT ac.article_id) AS n
FROM article_categories ac
JOIN articles a ON a.id = ac.article_id AND a.published = 1
WHERE ac.category_id IN (SELECT id FROM subtree)
`;

/** 分类相对其顶层祖先的深度（顶层为 1）。 */
const DEPTH_SQL = `
WITH RECURSIVE chain(pid, depth) AS (
  SELECT parent_id, 1 FROM categories WHERE id = ?
  UNION ALL
  SELECT c.parent_id, ch.depth + 1
  FROM chain ch JOIN categories c ON c.id = ch.pid
)
SELECT MAX(depth) AS depth FROM chain
`;

/** 子树内部的最大相对高度（自身为 1）。 */
const SUBTREE_HEIGHT_SQL = `
WITH RECURSIVE subtree(id, height) AS (
  SELECT id, 1 FROM categories WHERE id = ?
  UNION ALL
  SELECT c.id, s.height + 1
  FROM categories c JOIN subtree s ON c.parent_id = s.id
)
SELECT MAX(height) AS height FROM subtree
`;

/**
 * 内容库分类统计模块。
 * 所有修改方法都在单个事务内完成，返回后读取到的即为整次修改后的状态。
 */
export class ContentLibrary {
  private readonly db: DatabaseSync;

  constructor(options: ContentLibraryOptions = {}) {
    this.db = openDatabase(options.filename ?? ":memory:");
  }

  /** 新增一个分类；parentId 为 null 时作为顶层分类。层级不得超过四层。 */
  addCategory(id: CategoryId, parentId: CategoryId | null = null): void {
    if (this.categoryExists(id)) {
      throw new Error(`category already exists: ${id}`);
    }
    if (parentId !== null) {
      this.requireCategory(parentId);
      if (this.depthOf(parentId) + 1 > MAX_CATEGORY_DEPTH) {
        throw new Error(`category depth would exceed ${MAX_CATEGORY_DEPTH}`);
      }
    }
    this.db.prepare("INSERT INTO categories (id, parent_id) VALUES (?, ?)").run(
      id,
      parentId,
    );
  }

  /** 新增或整体替换一篇文章的发布状态与直接归属。重复提交相同内容不改变计数。 */
  upsertArticle(article: ArticleInput): void {
    const categoryIds = [...new Set(article.categoryIds)];
    if (categoryIds.length > MAX_DIRECT_CATEGORIES) {
      throw new Error(
        `article may have at most ${MAX_DIRECT_CATEGORIES} direct categories`,
      );
    }
    for (const categoryId of categoryIds) {
      this.requireCategory(categoryId);
    }
    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO articles (id, published) VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET published = excluded.published`,
        )
        .run(article.id, article.published ? 1 : 0);
      this.db
        .prepare("DELETE FROM article_categories WHERE article_id = ?")
        .run(article.id);
      const insert = this.db.prepare(
        "INSERT INTO article_categories (article_id, category_id) VALUES (?, ?)",
      );
      for (const categoryId of categoryIds) {
        insert.run(article.id, categoryId);
      }
    });
  }

  /** 将分类及其完整子树迁移到新父分类下；newParentId 为 null 时移到顶层。 */
  moveCategory(id: CategoryId, newParentId: CategoryId | null): void {
    this.requireCategory(id);
    if (newParentId === id) {
      throw new Error("category cannot be its own parent");
    }
    if (newParentId !== null) {
      this.requireCategory(newParentId);
      if (this.isInSubtree(newParentId, id)) {
        throw new Error("moving a category under its own descendant");
      }
      if (this.depthOf(newParentId) + this.subtreeHeight(id) > MAX_CATEGORY_DEPTH) {
        throw new Error(`category depth would exceed ${MAX_CATEGORY_DEPTH}`);
      }
    }
    this.db
      .prepare("UPDATE categories SET parent_id = ? WHERE id = ?")
      .run(newParentId, id);
  }

  /** 读取分类的覆盖计数：自身及全部后代范围内、已发布文章的去重数量。 */
  getCoverageCount(id: CategoryId): number {
    this.requireCategory(id);
    const row = this.db.prepare(COVERAGE_SQL).get(id) as { n: number };
    return row.n;
  }

  /** 关闭底层数据库连接。 */
  close(): void {
    this.db.close();
  }

  private categoryExists(id: CategoryId): boolean {
    return (
      this.db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id) !==
      undefined
    );
  }

  private requireCategory(id: CategoryId): void {
    if (!this.categoryExists(id)) {
      throw new Error(`unknown category: ${id}`);
    }
  }

  private depthOf(id: CategoryId): number {
    const row = this.db.prepare(DEPTH_SQL).get(id) as { depth: number };
    return row.depth;
  }

  private subtreeHeight(id: CategoryId): number {
    const row = this.db.prepare(SUBTREE_HEIGHT_SQL).get(id) as {
      height: number;
    };
    return row.height;
  }

  private isInSubtree(id: CategoryId, rootId: CategoryId): boolean {
    let current: CategoryId | null = id;
    while (current !== null) {
      if (current === rootId) return true;
      const row = this.db
        .prepare("SELECT parent_id FROM categories WHERE id = ?")
        .get(current) as { parent_id: CategoryId | null };
      current = row.parent_id;
    }
    return false;
  }

  private inTransaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
