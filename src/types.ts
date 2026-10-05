/** 交易状态：failed 计为失败，其余一律计为成功（非失败）。 */
export type TransactionStatus = "failed" | "success" | string;

/** 单条交易记录。同一 transaction_id 的重复记录内容相同。 */
export interface Transaction {
  transaction_id: string;
  terminal_id: string;
  /** UTC 毫秒时间戳。 */
  timestamp: number;
  status: TransactionStatus;
}

/** 告警变化类型：start = 首次超阈边界，end = 首次不再超阈边界。 */
export type AlertChangeType = "start" | "end";

/** 一次告警状态变化。 */
export interface AlertChange {
  terminal_id: string;
  type: AlertChangeType;
  /** 状态翻转发生的边界时刻（UTC 毫秒）。 */
  timestamp: number;
}
