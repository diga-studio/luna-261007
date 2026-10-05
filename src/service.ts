import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";
import {
  CapacityExceededError,
  DuplicateOrderError,
  InvalidSlotsError,
  PickupNotStartedError,
  ReservationError,
  ReservationNotActiveError,
  ReservationNotFoundError,
  ShiftAlreadyExistsError,
  ShiftExpiredError,
  ShiftNotFoundError,
} from "./errors.js";
import type { Store } from "./store.js";
import type { BatchOperation, Reservation, Shift, ShiftStatus } from "./types.js";

/** 取件截止 = 班次取件起点 + 72 小时；恰好到达即超时。 */
export const PICKUP_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface ReservationServiceOptions {
  store: Store;
  clock: Clock;
  idGenerator?: () => string;
}

/** 履约预约名额服务，供上层直接调用。 */
export class ReservationService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly idGenerator: () => string;

  constructor(options: ReservationServiceOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
  }

  /** 录入班次，录入后容量与取件起点不变。 */
  registerShift(shiftId: string, capacity: number, pickupStartMs: number): void {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new ReservationError("INVALID_CAPACITY", `capacity must be a non-negative integer, got: ${capacity}`);
    }
    if (this.store.getShift(shiftId)) {
      throw new ShiftAlreadyExistsError(shiftId);
    }
    this.store.insertShift({ id: shiftId, capacity, pickupStartMs });
  }

  /** 单笔创建预约，成功即占用名额；班次已到截止时间则拒绝。 */
  createReservation(orderId: string, shiftId: string, slots: number): Reservation {
    if (!Number.isInteger(slots) || slots <= 0) {
      throw new InvalidSlotsError(slots);
    }
    return this.store.transaction(() => {
      const shift = this.requireShift(shiftId);
      const now = this.clock.nowMs();
      if (this.isExpired(shift, now)) {
        throw new ShiftExpiredError(shiftId);
      }
      if (this.store.getReservationByOrder(orderId)) {
        throw new DuplicateOrderError(orderId);
      }
      const { pickedUpSlots, pendingSlots } = this.store.occupiedSlots(shiftId, now);
      if (pickedUpSlots + pendingSlots + slots > shift.capacity) {
        throw new CapacityExceededError(shiftId);
      }
      const reservation: Reservation = {
        id: this.idGenerator(),
        orderId,
        shiftId,
        slots,
        status: "active",
        createdAtMs: now,
        updatedAtMs: now,
      };
      this.store.insertReservation(reservation);
      return reservation;
    });
  }

  /** 确认取件：取件起点 <= now < 截止；已取件后永久占用，不再超时、不可取消或改约。 */
  confirmPickup(reservationId: string): void {
    this.store.transaction(() => {
      const reservation = this.store.getReservation(reservationId);
      if (!reservation) {
        throw new ReservationNotFoundError(reservationId);
      }
      if (reservation.status !== "active") {
        throw new ReservationNotActiveError(reservationId);
      }
      const shift = this.requireShift(reservation.shiftId);
      const now = this.clock.nowMs();
      if (now < shift.pickupStartMs) {
        throw new PickupNotStartedError(shift.id);
      }
      if (this.isExpired(shift, now)) {
        throw new ReservationNotActiveError(reservationId);
      }
      this.store.updateReservationStatus(reservationId, "picked_up", now);
    });
  }

  /**
   * 整批取消/改约，全部生效或全部不生效。
   * 容量按整批生效后的净占用判断；任一预约已取消/已取件/已超时，
   * 或目标班次已到截止时间，整批不生效且不影响其他预约。
   */
  applyBatch(operations: BatchOperation[]): void {
    if (operations.length === 0) {
      return;
    }
    this.store.transaction(() => {
      const now = this.clock.nowMs();
      const seen = new Set<string>();
      const removedByShift = new Map<string, number>();
      const addedByShift = new Map<string, number>();
      const moves: Array<{ reservationId: string; targetShiftId: string }> = [];
      const cancels: string[] = [];

      const addTo = (map: Map<string, number>, shiftId: string, slots: number) => {
        map.set(shiftId, (map.get(shiftId) ?? 0) + slots);
      };

      for (const op of operations) {
        if (seen.has(op.reservationId)) {
          throw new ReservationError("DUPLICATE_OPERATION", `duplicate operation for reservation: ${op.reservationId}`);
        }
        seen.add(op.reservationId);
        const reservation = this.store.getReservation(op.reservationId);
        if (!reservation) {
          throw new ReservationNotFoundError(op.reservationId);
        }
        if (reservation.status !== "active") {
          throw new ReservationNotActiveError(op.reservationId);
        }
        const currentShift = this.requireShift(reservation.shiftId);
        if (this.isExpired(currentShift, now)) {
          throw new ReservationNotActiveError(op.reservationId);
        }
        if (op.kind === "cancel") {
          addTo(removedByShift, currentShift.id, reservation.slots);
          cancels.push(op.reservationId);
        } else {
          const targetShift = this.requireShift(op.targetShiftId);
          if (this.isExpired(targetShift, now)) {
            throw new ShiftExpiredError(targetShift.id);
          }
          addTo(removedByShift, currentShift.id, reservation.slots);
          addTo(addedByShift, targetShift.id, reservation.slots);
          moves.push({ reservationId: op.reservationId, targetShiftId: targetShift.id });
        }
      }

      const affected = new Set<string>([...removedByShift.keys(), ...addedByShift.keys()]);
      for (const shiftId of affected) {
        const shift = this.requireShift(shiftId);
        const { pickedUpSlots, pendingSlots } = this.store.occupiedSlots(shiftId, now);
        const net = pickedUpSlots + pendingSlots - (removedByShift.get(shiftId) ?? 0) + (addedByShift.get(shiftId) ?? 0);
        if (net > shift.capacity) {
          throw new CapacityExceededError(shiftId);
        }
      }

      for (const reservationId of cancels) {
        this.store.updateReservationStatus(reservationId, "cancelled", now);
      }
      for (const move of moves) {
        this.store.updateReservationShift(move.reservationId, move.targetShiftId, now);
      }
    });
  }

  /** 到期清理：把已超时的未取件预约标记为失效（业务口径不依赖本方法是否执行）。 */
  cleanupExpired(): string[] {
    return this.store.transaction(() => this.store.markExpired(this.clock.nowMs()));
  }

  /** 查看班次占用状态。 */
  getShiftStatus(shiftId: string): ShiftStatus {
    const shift = this.requireShift(shiftId);
    const { pickedUpSlots, pendingSlots } = this.store.occupiedSlots(shiftId, this.clock.nowMs());
    const occupiedSlots = pickedUpSlots + pendingSlots;
    return {
      shiftId: shift.id,
      capacity: shift.capacity,
      pickedUpSlots,
      pendingSlots,
      occupiedSlots,
      availableSlots: shift.capacity - occupiedSlots,
    };
  }

  getReservation(reservationId: string): Reservation {
    const reservation = this.store.getReservation(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }
    return reservation;
  }

  private requireShift(shiftId: string): Shift {
    const shift = this.store.getShift(shiftId);
    if (!shift) {
      throw new ShiftNotFoundError(shiftId);
    }
    return shift;
  }

  /** 恰好到达截止时间即超时。 */
  private isExpired(shift: Shift, nowMs: number): boolean {
    return nowMs >= shift.pickupStartMs + PICKUP_WINDOW_MS;
  }
}
