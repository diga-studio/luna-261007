/** 授权实例状态 */
export type GrantStatus = "active" | "suspended" | "revoked";

/** 复核条目状态 */
export type ReviewItemStatus = "pending" | "confirmed" | "revoked";

/** 决定类型 */
export type Decision = "confirm" | "revoke";

/** 授权实例（一次授予产生的独立记录） */
export interface Grant {
  id: string;
  userId: string;
  databaseId: string;
  role: string;
  /** 是否已撤销（终态） */
  revoked: boolean;
  grantedAt: number;
  revokedAt: number | null;
}

/** 复核周期 */
export interface ReviewCycle {
  id: string;
  databaseId: string;
  openedAt: number;
  /** openedAt + 14*24h */
  deadline: number;
}

/** 复核条目：某周期内针对一个授权实例的待审记录 */
export interface ReviewItem {
  id: string;
  cycleId: string;
  grantId: string;
  status: ReviewItemStatus;
  decidedAt: number | null;
}

/** 授权有效性读取结果 */
export interface GrantAvailability {
  grantId: string;
  status: GrantStatus;
  /** 当前导致挂起的已逾期待审条目 */
  suspendingItemIds: string[];
}

/** 批量决定中的一项 */
export interface DecisionInput {
  itemId: string;
  decision: Decision;
}
