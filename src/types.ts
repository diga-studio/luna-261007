/** 文章的直接归属分类数量上限。 */
export const MAX_DIRECT_CATEGORIES = 8;
/** 分类层级的最大深度，顶层为第一层。 */
export const MAX_CATEGORY_DEPTH = 4;

export type CategoryId = string;
export type ArticleId = string;

/** 文章的发布状态与直接归属分类。 */
export interface ArticleInput {
  id: ArticleId;
  published: boolean;
  /** 直接归属的分类，至多 8 个，可以为空数组。 */
  categoryIds: CategoryId[];
}

/** 内容库的配置项。 */
export interface ContentLibraryOptions {
  /** SQLite 文件路径；省略或传 ":memory:" 时使用内存数据库。 */
  filename?: string;
}
