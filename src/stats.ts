import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import { ArticleInput, Category, PublishStatus, StatsLibraryOptions } from "./types";

const MAX_DEPTH = 4;
const MAX_DIRECT_CATEGORIES = 8;

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
}

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, parentId: row.parent_id };
}

/**
 * 分类覆盖统计库：由上层直接调用，无接口层。
 *
 * 计数策略：读取时基于当前分类树用递归 CTE 实时计算，
 * 因此任何迁移 / 归属替换 / 状态切换在事务提交后立即整体可见，
 * 同一文章命中同一子树内多个分类时只计一次。
 */
export class CategoryStats {
  private readonly db: DatabaseSync;

  constructor(options: StatsLibraryOptions) {
    this.db = openDatabase(options.dbPath);
  }

  /** 新增分类；parentId 为 null 表示顶层。返回新分类 id */
  createCategory(name: string, parentId: string | null): string {
    if (parentId !== null) {
      const parentLevel = this.levelOf(parentId);
      if (parentLevel === null) {
        throw new Error(`父分类不存在: ${parentId}`);
      }
      if (parentLevel + 1 > MAX_DEPTH) {
        throw new Error(`分类层级超过 ${MAX_DEPTH} 层`);
      }
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO categories (id, name, parent_id) VALUES (?, ?, ?)")
      .run(id, name, parentId);
    return id;
  }

  /** 新增文章，或整体替换一篇文章的发布状态与归属（幂等） */
  upsertArticle(article: ArticleInput): void {
    if (!article.id) {
      throw new Error("文章 id 不能为空");
    }
    if (article.status !== "published" && article.status !== "unpublished") {
      throw new Error(`非法发布状态: ${article.status}`);
    }
    const categoryIds = [...new Set(article.categoryIds)];
    if (categoryIds.length > MAX_DIRECT_CATEGORIES) {
      throw new Error(`文章直接归属分类数超过 ${MAX_DIRECT_CATEGORIES} 个`);
    }
    for (const categoryId of categoryIds) {
      if (!this.categoryExists(categoryId)) {
        throw new Error(`分类不存在: ${categoryId}`);
      }
    }
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO articles (id, status) VALUES (?, ?)")
        .run(article.id, article.status as PublishStatus);
      this.db
        .prepare("DELETE FROM article_categories WHERE article_id = ?")
        .run(article.id);
      const insert = this.db.prepare(
        "INSERT INTO article_categories (article_id, category_id) VALUES (?, ?)"
      );
      for (const categoryId of categoryIds) {
        insert.run(article.id, categoryId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 将分类及其子树迁移到新父分类下；newParentId 为 null 表示移到顶层 */
  moveCategory(categoryId: string, newParentId: string | null): void {
    const category = this.getCategory(categoryId);
    if (!category) {
      throw new Error(`分类不存在: ${categoryId}`);
    }
    if (newParentId !== null) {
      if (newParentId === categoryId) {
        throw new Error("不能把分类迁移到自身之下");
      }
      const parentLevel = this.levelOf(newParentId);
      if (parentLevel === null) {
        throw new Error(`父分类不存在: ${newParentId}`);
      }
      const subtreeHeight = this.subtreeHeight(categoryId);
      if (parentLevel + subtreeHeight > MAX_DEPTH) {
        throw new Error(`迁移后分类层级超过 ${MAX_DEPTH} 层`);
      }
    }
    this.db
      .prepare("UPDATE categories SET parent_id = ? WHERE id = ?")
      .run(newParentId, categoryId);
  }

  /** 读取分类信息 */
  getCategory(categoryId: string): Category | null {
    const row = this.db
      .prepare("SELECT id, name, parent_id FROM categories WHERE id = ?")
      .get(categoryId) as CategoryRow | undefined;
    return row ? toCategory(row) : null;
  }

  /** 读取某分类的覆盖计数（自身及全部后代，已发布文章去重） */
  getCoverageCount(categoryId: string): number {
    if (!this.categoryExists(categoryId)) {
      throw new Error(`分类不存在: ${categoryId}`);
    }
    const row = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM categories WHERE id = ?
           UNION ALL
           SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
         )
         SELECT COUNT(DISTINCT ac.article_id) AS cnt
         FROM article_categories ac
         JOIN articles a ON a.id = ac.article_id
         WHERE a.status = 'published' AND ac.category_id IN (SELECT id FROM subtree)`
      )
      .get(categoryId) as { cnt: number };
    return Number(row.cnt);
  }

  close(): void {
    this.db.close();
  }

  private categoryExists(categoryId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS x FROM categories WHERE id = ?")
        .get(categoryId) !== undefined
    );
  }

  /** 分类所在层级（顶层为 1）；不存在返回 null */
  private levelOf(categoryId: string): number | null {
    const row = this.db
      .prepare(
        `WITH RECURSIVE chain(id, parent_id, lvl) AS (
           SELECT id, parent_id, 1 FROM categories WHERE id = ?
           UNION ALL
           SELECT c.id, c.parent_id, chain.lvl + 1
           FROM categories c JOIN chain ON c.id = chain.parent_id
         )
         SELECT MAX(lvl) AS lvl FROM chain`
      )
      .get(categoryId) as { lvl: number | null };
    return row.lvl === null ? null : Number(row.lvl);
  }

  /** 子树高度（仅自身为 1） */
  private subtreeHeight(categoryId: string): number {
    const row = this.db
      .prepare(
        `WITH RECURSIVE subtree(id, depth) AS (
           SELECT id, 1 FROM categories WHERE id = ?
           UNION ALL
           SELECT c.id, subtree.depth + 1
           FROM categories c JOIN subtree ON c.parent_id = subtree.id
         )
         SELECT MAX(depth) AS h FROM subtree`
      )
      .get(categoryId) as { h: number | null };
    return row.h === null ? 0 : Number(row.h);
  }
}
