import { DatabaseSync } from "node:sqlite";
import { Clock, SystemClock } from "./clock.js";
import { initSchema } from "./schema.js";
import {
  BatchChange,
  PICKUP_WINDOW_MS,
  Reservation,
  ReservationError,
  ReservationView,
  ReservationViewState,
  Shift,
  ShiftStatus,
} from "./types.js";

export interface ReservationServiceOptions {
  clock?: Clock;
}

interface ShiftRow {
  id: string;
  capacity: number;
  pickup_start_utc: number;
}

interface ReservationRow {
  order_id: string;
  shift_id: string;
  slots: number;
  state: string;
  expired_marked: number;
  created_at_utc: number;
  updated_at_utc: number;
}

function toShift(row: ShiftRow): Shift {
  return {
    id: row.id,
    capacity: row.capacity,
    pickupStartUtc: row.pickup_start_utc,
  };
}

function toReservation(row: ReservationRow): Reservation {
  return {
    orderId: row.order_id,
    shiftId: row.shift_id,
    slots: row.slots,
    state: row.state as Reservation["state"],
    expiredMarked: row.expired_marked !== 0,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

export class ReservationService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(dbPath: string, options: ReservationServiceOptions = {}) {
    this.db = new DatabaseSync(dbPath);
    this.clock = options.clock ?? new SystemClock();
    initSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  createShift(shiftId: string, capacity: number, pickupStartUtc: number): void {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new ReservationError(
        "INVALID_CAPACITY",
        `capacity must be a positive integer, got ${capacity}`,
      );
    }
    const existing = this.db
      .prepare("SELECT id FROM shifts WHERE id = ?")
      .get(shiftId);
    if (existing) {
      throw new ReservationError(
        "SHIFT_EXISTS",
        `shift ${shiftId} already exists`,
      );
    }
    this.db
      .prepare(
        "INSERT INTO shifts (id, capacity, pickup_start_utc) VALUES (?, ?, ?)",
      )
      .run(shiftId, capacity, Math.trunc(pickupStartUtc));
  }

  getShift(shiftId: string): Shift {
    return toShift(this.mustGetShiftRow(shiftId));
  }

  createReservation(orderId: string, shiftId: string, slots: number): void {
    if (!Number.isInteger(slots) || slots <= 0) {
      throw new ReservationError(
        "INVALID_SLOTS",
        `slots must be a positive integer, got ${slots}`,
      );
    }
    const now = this.clock.now();
    this.inTransaction(() => {
      const dup = this.db
        .prepare("SELECT order_id FROM reservations WHERE order_id = ?")
        .get(orderId);
      if (dup) {
        throw new ReservationError(
          "DUPLICATE_ORDER",
          `order ${orderId} already has a reservation`,
        );
      }
      const shift = this.mustGetShiftRow(shiftId);
      if (this.isExpiredAt(shift, now)) {
        throw new ReservationError(
          "SHIFT_PAST_DEADLINE",
          `shift ${shiftId} is past its deadline`,
        );
      }
      const occupied = this.occupiedSlots(shiftId, now);
      const capacity = shift.capacity;
      if (occupied + slots > capacity) {
        throw new ReservationError(
          "CAPACITY_EXCEEDED",
          `shift ${shiftId} has ${occupied}/${capacity} occupied, cannot add ${slots}`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO reservations
             (order_id, shift_id, slots, state, expired_marked, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, 'active', 0, ?, ?)`,
        )
        .run(orderId, shiftId, slots, now, now);
    });
  }

  confirmPickup(orderId: string): void {
    const now = this.clock.now();
    this.inTransaction(() => {
      const reservation = this.mustGetReservation(orderId);
      if (reservation.state === "confirmed") {
        return; // 幂等：已确认取件保持最终结果
      }
      if (reservation.state !== "active") {
        throw new ReservationError(
          "RESERVATION_NOT_CHANGEABLE",
          `reservation ${orderId} is ${reservation.state}`,
        );
      }
      const shift = this.mustGetShiftRow(reservation.shiftId);
      if (now < shift.pickup_start_utc) {
        throw new ReservationError(
          "RESERVATION_NOT_CHANGEABLE",
          `pickup for ${orderId} not allowed before shift start`,
        );
      }
      if (this.isExpiredAt(shift, now)) {
        throw new ReservationError(
          "RESERVATION_NOT_CHANGEABLE",
          `reservation ${orderId} is expired`,
        );
      }
      this.db
        .prepare(
          "UPDATE reservations SET state = 'confirmed', updated_at_utc = ? WHERE order_id = ?",
        )
        .run(now, orderId);
    });
  }

  /** 批量取消/改约，整批全部生效或全部不生效。 */
  applyBatch(changes: BatchChange[]): void {
    const now = this.clock.now();
    this.inTransaction(() => {
      const seen = new Set<string>();
      interface Planned {
        reservation: Reservation;
        targetShiftId: string | null; // null 表示取消
      }
      const planned: Planned[] = [];
      for (const change of changes) {
        if (seen.has(change.orderId)) {
          throw new ReservationError(
            "RESERVATION_NOT_CHANGEABLE",
            `order ${change.orderId} appears twice in batch`,
          );
        }
        seen.add(change.orderId);
        const reservation = this.mustGetReservation(change.orderId);
        if (reservation.state !== "active") {
          throw new ReservationError(
            "RESERVATION_NOT_CHANGEABLE",
            `reservation ${change.orderId} is ${reservation.state}`,
          );
        }
        const currentShift = this.mustGetShiftRow(reservation.shiftId);
        if (this.isExpiredAt(currentShift, now)) {
          throw new ReservationError(
            "RESERVATION_NOT_CHANGEABLE",
            `reservation ${change.orderId} is expired`,
          );
        }
        if (change.kind === "rebook") {
          const target = this.mustGetShiftRow(change.targetShiftId);
          if (this.isExpiredAt(target, now)) {
            throw new ReservationError(
              "SHIFT_PAST_DEADLINE",
              `target shift ${change.targetShiftId} is past its deadline`,
            );
          }
          planned.push({ reservation, targetShiftId: change.targetShiftId });
        } else {
          planned.push({ reservation, targetShiftId: null });
        }
      }

      // 按整批生效后的净占用校验容量
      const deltas = new Map<string, number>();
      const addDelta = (shiftId: string, delta: number) => {
        deltas.set(shiftId, (deltas.get(shiftId) ?? 0) + delta);
      };
      for (const { reservation, targetShiftId } of planned) {
        addDelta(reservation.shiftId, -reservation.slots);
        if (targetShiftId !== null) {
          addDelta(targetShiftId, reservation.slots);
        }
      }
      for (const [shiftId, delta] of deltas) {
        if (delta === 0) continue;
        const shift = this.mustGetShiftRow(shiftId);
        const net = this.occupiedSlots(shiftId, now) + delta;
        if (net > shift.capacity) {
          throw new ReservationError(
            "CAPACITY_EXCEEDED",
            `shift ${shiftId} would reach ${net}/${shift.capacity}`,
          );
        }
      }

      for (const { reservation, targetShiftId } of planned) {
        if (targetShiftId === null) {
          this.db
            .prepare(
              "UPDATE reservations SET state = 'cancelled', updated_at_utc = ? WHERE order_id = ?",
            )
            .run(now, reservation.orderId);
        } else {
          this.db
            .prepare(
              "UPDATE reservations SET shift_id = ?, updated_at_utc = ? WHERE order_id = ?",
            )
            .run(targetShiftId, now, reservation.orderId);
        }
      }
    });
  }

  /** 到期清理：把已超时的未取件预约标记为 expired（业务口径不依赖本操作）。 */
  sweepExpired(): number {
    const now = this.clock.now();
    let marked = 0;
    this.inTransaction(() => {
      const result = this.db
        .prepare(
          `UPDATE reservations SET expired_marked = 1, updated_at_utc = ?
           WHERE state = 'active' AND expired_marked = 0
             AND shift_id IN (
               SELECT id FROM shifts WHERE pickup_start_utc + ? <= ?
             )`,
        )
        .run(now, PICKUP_WINDOW_MS, now);
      marked = Number(result.changes);
    });
    return marked;
  }

  getShiftStatus(shiftId: string): ShiftStatus {
    const now = this.clock.now();
    const shift = this.mustGetShiftRow(shiftId);
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN r.state = 'confirmed' THEN r.slots ELSE 0 END), 0) AS confirmed_slots,
           COALESCE(SUM(CASE WHEN r.state = 'active' AND s.pickup_start_utc + ? > ? THEN r.slots ELSE 0 END), 0) AS active_slots
         FROM shifts s
         LEFT JOIN reservations r ON r.shift_id = s.id
         WHERE s.id = ?
         GROUP BY s.id`,
      )
      .get(PICKUP_WINDOW_MS, now, shiftId) as unknown as {
      confirmed_slots: number;
      active_slots: number;
    };
    const confirmedSlots = Number(row.confirmed_slots);
    const activeSlots = Number(row.active_slots);
    const occupied = confirmedSlots + activeSlots;
    return {
      shiftId,
      capacity: shift.capacity,
      occupied,
      available: shift.capacity - occupied,
      confirmedSlots,
      activeSlots,
    };
  }

  getReservation(orderId: string): ReservationView {
    const now = this.clock.now();
    const reservation = this.mustGetReservation(orderId);
    const shift = this.mustGetShiftRow(reservation.shiftId);
    const deadlineUtc = shift.pickup_start_utc + PICKUP_WINDOW_MS;
    let state: ReservationViewState;
    if (reservation.state === "active" && now >= deadlineUtc) {
      state = "expired";
    } else {
      state = reservation.state;
    }
    return {
      orderId: reservation.orderId,
      shiftId: reservation.shiftId,
      slots: reservation.slots,
      state,
      pickupStartUtc: shift.pickup_start_utc,
      deadlineUtc,
    };
  }

  private mustGetShiftRow(shiftId: string): ShiftRow {
    const row = this.db
      .prepare("SELECT * FROM shifts WHERE id = ?")
      .get(shiftId) as unknown as ShiftRow | undefined;
    if (!row) {
      throw new ReservationError(
        "SHIFT_NOT_FOUND",
        `shift ${shiftId} not found`,
      );
    }
    return row;
  }

  private mustGetReservation(orderId: string): Reservation {
    const row = this.db
      .prepare("SELECT * FROM reservations WHERE order_id = ?")
      .get(orderId) as unknown as ReservationRow | undefined;
    if (!row) {
      throw new ReservationError(
        "RESERVATION_NOT_FOUND",
        `reservation ${orderId} not found`,
      );
    }
    return toReservation(row);
  }

  /** 班次占用 = 已确认名额 + 未取消且未超时的未取件名额（与是否已清理无关）。 */
  private occupiedSlots(shiftId: string, now: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(r.slots), 0) AS occupied
         FROM reservations r
         JOIN shifts s ON s.id = r.shift_id
         WHERE r.shift_id = ?
           AND (r.state = 'confirmed'
                OR (r.state = 'active' AND s.pickup_start_utc + ? > ?))`,
      )
      .get(shiftId, PICKUP_WINDOW_MS, now) as unknown as { occupied: number };
    return Number(row.occupied);
  }

  private isExpiredAt(shift: ShiftRow, now: number): boolean {
    return now >= shift.pickup_start_utc + PICKUP_WINDOW_MS;
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
