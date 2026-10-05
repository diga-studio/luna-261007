/** 文章发布状态 */
export type PublishStatus = "published" | "unpublished";

/** 文章输入：唯一标识 + 发布状态 + 直接归属分类（至多 8 个，可为空） */
export interface ArticleInput {
  id: string;
  status: PublishStatus;
  categoryIds: string[];
}

/** 分类节点 */
export interface Category {
  id: string;
  name: string;
  /** 顶层分类为 null */
  parentId: string | null;
}

/** 库配置 */
export interface StatsLibraryOptions {
  /** SQLite 文件路径；":memory:" 表示内存库 */
  dbPath: string;
}
