/** 班次：容量与 UTC 取件起点由上层提供，录入后不变。 */
export interface Shift {
  id: string;
  capacity: number;
  /** UTC 毫秒时间戳 */
  pickupStartUtc: number;
}

/** 预约的持久化状态。到期（expired）由业务时钟推导，不作为存储状态。 */
export type ReservationState = "active" | "confirmed" | "cancelled";

export interface Reservation {
  orderId: string;
  shiftId: string;
  slots: number;
  state: ReservationState;
  /** 是否已被到期清理标记（不影响业务口径，仅记录） */
  expiredMarked: boolean;
  createdAtUtc: number;
  updatedAtUtc: number;
}

/** 取件截止时间 = 班次取件起点 + 72 小时（毫秒） */
export const PICKUP_WINDOW_MS = 72 * 60 * 60 * 1000;

/** 批量变更项：取消 或 改约到新班次 */
export type BatchChange =
  | { kind: "cancel"; orderId: string }
  | { kind: "rebook"; orderId: string; targetShiftId: string };

export interface ShiftStatus {
  shiftId: string;
  capacity: number;
  /** 已确认取件名额 + 未取消未超时的未取件名额 */
  occupied: number;
  available: number;
  confirmedSlots: number;
  activeSlots: number;
}

export type ReservationViewState =
  | "active"
  | "confirmed"
  | "cancelled"
  | "expired";

export interface ReservationView {
  orderId: string;
  shiftId: string;
  slots: number;
  state: ReservationViewState;
  pickupStartUtc: number;
  deadlineUtc: number;
}

export type ErrorCode =
  | "SHIFT_NOT_FOUND"
  | "RESERVATION_NOT_FOUND"
  | "DUPLICATE_ORDER"
  | "INVALID_SLOTS"
  | "INVALID_CAPACITY"
  | "SHIFT_EXISTS"
  | "CAPACITY_EXCEEDED"
  | "RESERVATION_NOT_CHANGEABLE"
  | "SHIFT_PAST_DEADLINE";

export class ReservationError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ReservationError";
    this.code = code;
  }
}
