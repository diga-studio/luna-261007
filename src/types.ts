/** 用户标识 */
export type UserId = string;

/** 全局数据版本，只递增 */
export type DataVersion = number;

/**
 * 上层提供的本地异步推荐计算器。
 * 接收用户标识和数据版本，返回推荐列表。本模块不实现推荐算法。
 */
export type RecommendationComputer<TItem> = (
  userId: UserId,
  version: DataVersion,
) => Promise<TItem[]>;

/** 查询结果状态：调用方可区分正常结果、陈旧降级和暂不可用 */
export type QueryStatus =
  | 'fresh'       // 命中新鲜缓存
  | 'computed'    // 本次计算在预算内正常完成
  | 'stale'       // 计算失败或预算耗尽，降级返回陈旧缓存
  | 'unavailable'; // 计算失败或预算耗尽，且无可用陈旧缓存

export type QueryResult<TItem> =
  | { status: 'fresh'; items: TItem[] }
  | { status: 'computed'; items: TItem[] }
  | { status: 'stale'; items: TItem[] }
  | { status: 'unavailable' };
