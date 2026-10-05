import { DatabaseSync } from "node:sqlite";

/** 初始化数据库结构（幂等）。 */
export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL,
      pickup_start_utc INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reservations (
      order_id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL REFERENCES shifts(id),
      slots INTEGER NOT NULL,
      state TEXT NOT NULL,
      expired_marked INTEGER NOT NULL DEFAULT 0,
      created_at_utc INTEGER NOT NULL,
      updated_at_utc INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_shift ON reservations(shift_id);
  `);
}
