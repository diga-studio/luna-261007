/** 兑换生命周期状态 */
export type RedemptionStatus =
  | "PENDING" // 已受理，履约尝试进行中
  | "CANCELLING" // 已申请取消，仍有已启动尝试未返回
  | "COMPLETED" // 已交付（任一尝试成功）
  | "REJECTED" // 三次尝试均明确失败，资源已归还
  | "CANCELLED"; // 取消终结，资源已归还

export type QuarterId = string; // 形如 "2026-Q4"

export interface EmployeeInit {
  id: string;
  points: number;
}

export interface RewardInit {
  id: string;
  price: number;
  stock: number;
}

export interface RedemptionRecord {
  id: string;
  employeeId: string;
  rewardId: string;
  quarter: QuarterId;
  status: RedemptionStatus;
  cancelRequested: boolean;
  attemptsStarted: number;
  attemptsPending: number;
  acceptedAt: number;
  settledAt: number | null;
}

export type RejectReason = "INSUFFICIENT_POINTS" | "OUT_OF_STOCK" | "QUOTA_EXCEEDED";

export interface RedeemResult {
  redemption: RedemptionRecord | null;
  accepted: boolean;
  /** accepted=false 时的拒绝原因 */
  reason?: RejectReason;
  /** true 表示同 ID 重复发起，直接返回已有兑换，未再次扣减 */
  deduplicated?: boolean;
}

export interface CancelResult {
  redemption: RedemptionRecord;
}

export interface Snapshot {
  takenAt: number;
  employees: Array<{ id: string; availablePoints: number }>;
  rewards: Array<{ id: string; price: number; availableStock: number }>;
  quarterlyUsage: Array<{
    employeeId: string;
    rewardId: string;
    quarter: QuarterId;
    used: number;
  }>;
  redemptions: RedemptionRecord[];
}

/** 调用方提供的进程内异步 HR 处理动作；resolve=交付成功，reject=本次尝试未交付 */
export type HrAction = (redemptionId: string) => Promise<void>;

export interface RedemptionServiceOptions {
  /** 第 2、3 次尝试相对受理时刻的定时，默认 [5000, 10000] */
  retryDelaysMs?: [number, number];
  /** 注入时钟（测试用），默认 Date.now */
  now?: () => number;
}
