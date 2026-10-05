/** 通知终态与进行中状态 */
export type NotificationStatus = "queued" | "delivered" | "read" | "failed";

/** 接收方对某次尝试的落地结果 */
export interface DeliveryResult {
  ok: boolean;
  /** 结果首次落地的业务时间（毫秒） */
  landedAt: number;
}

/** 调用方提供的本机接收方接口 */
export interface Receiver {
  /**
   * 投递一次尝试。对同一 (notificationId, attempt) 重复调用必须返回相同结果。
   * 成功时保存实际可读消息，同一通知最多保存一条。
   */
  deliver(
    notificationId: string,
    attempt: number,
    message: string,
    now: number,
  ): Promise<DeliveryResult>;
  /** 查询某次尝试已落地的结果；无则返回 null */
  getResult(notificationId: string, attempt: number): DeliveryResult | null;
}

/** 通知状态快照 */
export interface NotificationState {
  id: string;
  status: NotificationStatus;
  /** 已完成的尝试次数 */
  attempts: number;
  /** 下一次可投递时间（毫秒）；无则为 null */
  nextAttemptAt: number | null;
}
