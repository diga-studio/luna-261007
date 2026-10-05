import { DatabaseSync } from "node:sqlite";
import type { Reservation, ReservationStatus, Shift } from "./types.js";

const WINDOW_MS = 72 * 60 * 60 * 1000;

interface ShiftRow {
  id: string;
  capacity: number;
  pickup_start_ms: number;
}

interface ReservationRow {
  id: string;
  order_id: string;
  shift_id: string;
  slots: number;
  status: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function toShift(row: ShiftRow): Shift {
  return { id: row.id, capacity: row.capacity, pickupStartMs: row.pickup_start_ms };
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    orderId: row.order_id,
    shiftId: row.shift_id,
    slots: row.slots,
    status: row.status as ReservationStatus,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/** SQLite 持久化层。 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL,
        pickup_start_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE,
        shift_id TEXT NOT NULL REFERENCES shifts(id),
        slots INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_shift ON reservations(shift_id, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  insertShift(shift: Shift): void {
    this.db
      .prepare("INSERT INTO shifts (id, capacity, pickup_start_ms) VALUES (?, ?, ?)")
      .run(shift.id, shift.capacity, shift.pickupStartMs);
  }

  getShift(shiftId: string): Shift | undefined {
    const row = this.db
      .prepare("SELECT id, capacity, pickup_start_ms FROM shifts WHERE id = ?")
      .get(shiftId) as ShiftRow | undefined;
    return row ? toShift(row) : undefined;
  }

  insertReservation(reservation: Reservation): void {
    this.db
      .prepare(
        `INSERT INTO reservations (id, order_id, shift_id, slots, status, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reservation.id,
        reservation.orderId,
        reservation.shiftId,
        reservation.slots,
        reservation.status,
        reservation.createdAtMs,
        reservation.updatedAtMs,
      );
  }

  getReservation(reservationId: string): Reservation | undefined {
    const row = this.db
      .prepare(
        "SELECT id, order_id, shift_id, slots, status, created_at_ms, updated_at_ms FROM reservations WHERE id = ?",
      )
      .get(reservationId) as ReservationRow | undefined;
    return row ? toReservation(row) : undefined;
  }

  getReservationByOrder(orderId: string): Reservation | undefined {
    const row = this.db
      .prepare(
        "SELECT id, order_id, shift_id, slots, status, created_at_ms, updated_at_ms FROM reservations WHERE order_id = ?",
      )
      .get(orderId) as ReservationRow | undefined;
    return row ? toReservation(row) : undefined;
  }

  updateReservationStatus(reservationId: string, status: ReservationStatus, updatedAtMs: number): void {
    this.db
      .prepare("UPDATE reservations SET status = ?, updated_at_ms = ? WHERE id = ?")
      .run(status, updatedAtMs, reservationId);
  }

  updateReservationShift(reservationId: string, shiftId: string, updatedAtMs: number): void {
    this.db
      .prepare("UPDATE reservations SET shift_id = ?, updated_at_ms = ? WHERE id = ?")
      .run(shiftId, updatedAtMs, reservationId);
  }

  /** 在单个事务中执行 fn，任一失败整体回滚。 */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 统计班次占用：已确认取件名额 + 未取消、未超时（相对 nowMs）的未取件名额。
   * 与到期清理是否已执行无关：active 但已超时的预约不计入。
   */
  occupiedSlots(shiftId: string, nowMs: number): { pickedUpSlots: number; pendingSlots: number } {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN r.status = 'picked_up' THEN r.slots ELSE 0 END), 0) AS picked_up,
           COALESCE(SUM(CASE WHEN r.status = 'active' AND s.pickup_start_ms + ${WINDOW_MS} > ? THEN r.slots ELSE 0 END), 0) AS pending
         FROM reservations r
         JOIN shifts s ON s.id = r.shift_id
         WHERE r.shift_id = ?`,
      )
      .get(nowMs, shiftId) as { picked_up: number; pending: number };
    return { pickedUpSlots: row.picked_up, pendingSlots: row.pending };
  }

  /** 将所有相对 nowMs 已超时的 active 预约标记为 expired，返回处理的预约 id。 */
  markExpired(nowMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT r.id AS id FROM reservations r
         JOIN shifts s ON s.id = r.shift_id
         WHERE r.status = 'active' AND s.pickup_start_ms + ${WINDOW_MS} <= ?`,
      )
      .all(nowMs) as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      this.db
        .prepare(
          `UPDATE reservations SET status = 'expired', updated_at_ms = ?
           WHERE status = 'active' AND shift_id IN (
             SELECT id FROM shifts WHERE pickup_start_ms + ${WINDOW_MS} <= ?
           )`,
        )
        .run(nowMs, nowMs);
    }
    return ids;
  }
}
