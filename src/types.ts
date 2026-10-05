/** 班次：容量与 UTC 取件起点由上层提供，录入后不变。 */
export interface Shift {
  id: string;
  capacity: number;
  /** UTC 取件起点，epoch 毫秒。 */
  pickupStartMs: number;
}

export type ReservationStatus = "active" | "cancelled" | "picked_up" | "expired";

/** 预约：每笔订单一份，名额需求为固定正整数。 */
export interface Reservation {
  id: string;
  orderId: string;
  shiftId: string;
  slots: number;
  status: ReservationStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 班次占用状态视图。 */
export interface ShiftStatus {
  shiftId: string;
  capacity: number;
  /** 已确认取件占用的名额（永久占用）。 */
  pickedUpSlots: number;
  /** 尚未取消、尚未超时的未取件预约名额。 */
  pendingSlots: number;
  /** pickedUpSlots + pendingSlots。 */
  occupiedSlots: number;
  availableSlots: number;
}

/** 整批变更中的一项：取消或改约。 */
export type BatchOperation =
  | { kind: "cancel"; reservationId: string }
  | { kind: "move"; reservationId: string; targetShiftId: string };
