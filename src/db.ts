import { DatabaseSync } from "node:sqlite";
import type {
  EmployeeInit,
  QuarterId,
  RedemptionRecord,
  RedemptionStatus,
  RejectReason,
  RewardInit,
  Snapshot,
} from "./types.ts";

/** 占用季度名额的状态：未终结 + 已完成 */
const OCCUPYING_STATUSES: RedemptionStatus[] = ["PENDING", "CANCELLING", "COMPLETED"];
const TERMINAL_STATUSES: RedemptionStatus[] = ["COMPLETED", "REJECTED", "CANCELLED"];

export type AcceptOutcome =
  | { kind: "duplicate"; record: RedemptionRecord }
  | { kind: "rejected"; reason: RejectReason }
  | { kind: "accepted"; record: RedemptionRecord };

interface Row {
  [key: string]: unknown;
}

function toRecord(row: Row): RedemptionRecord {
  return {
    id: row.id as string,
    employeeId: row.employee_id as string,
    rewardId: row.reward_id as string,
    quarter: row.quarter as QuarterId,
    status: row.status as RedemptionStatus,
    cancelRequested: (row.cancel_requested as number) === 1,
    attemptsStarted: row.attempts_started as number,
    attemptsPending: row.attempts_pending as number,
    acceptedAt: row.accepted_at as number,
    settledAt: (row.settled_at as number | null) ?? null,
  };
}

/** SQLite 持久化层。所有方法同步执行；多步写操作包裹在事务中，保证原子性。 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        points INTEGER NOT NULL CHECK (points >= 0)
      );
      CREATE TABLE IF NOT EXISTS rewards (
        id TEXT PRIMARY KEY,
        price INTEGER NOT NULL CHECK (price >= 0),
        stock INTEGER NOT NULL CHECK (stock >= 0)
      );
      CREATE TABLE IF NOT EXISTS redemptions (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        reward_id TEXT NOT NULL,
        quarter TEXT NOT NULL,
        status TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        attempts_started INTEGER NOT NULL DEFAULT 0,
        attempts_pending INTEGER NOT NULL DEFAULT 0,
        accepted_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_redemptions_quota
        ON redemptions (employee_id, reward_id, quarter, status);
    `);
  }

  private tx<T>(fn: () => T): T {
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

  seed(employees: EmployeeInit[], rewards: RewardInit[]): void {
    this.tx(() => {
      const insEmp = this.db.prepare(
        "INSERT INTO employees (id, points) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
      );
      for (const e of employees) insEmp.run(e.id, e.points);
      const insReward = this.db.prepare(
        "INSERT INTO rewards (id, price, stock) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
      );
      for (const r of rewards) insReward.run(r.id, r.price, r.stock);
    });
  }

  getRedemption(id: string): RedemptionRecord | null {
    const row = this.db.prepare("SELECT * FROM redemptions WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  /**
   * 原子地接受兑换：同 ID 去重；检查积分/库存/季度名额；全部满足才一次性扣减并落库。
   */
  tryAccept(
    id: string,
    employeeId: string,
    rewardId: string,
    quarter: QuarterId,
    now: number,
  ): AcceptOutcome {
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT * FROM redemptions WHERE id = ?")
        .get(id);
      if (existing) return { kind: "duplicate", record: toRecord(existing) };

      const employee = this.db
        .prepare("SELECT points FROM employees WHERE id = ?")
        .get(employeeId);
      if (!employee) throw new Error(`unknown employee: ${employeeId}`);
      const reward = this.db
        .prepare("SELECT price, stock FROM rewards WHERE id = ?")
        .get(rewardId);
      if (!reward) throw new Error(`unknown reward: ${rewardId}`);

      const price = reward.price as number;
      if ((employee.points as number) < price) {
        return { kind: "rejected", reason: "INSUFFICIENT_POINTS" };
      }
      if ((reward.stock as number) < 1) {
        return { kind: "rejected", reason: "OUT_OF_STOCK" };
      }
      const quotaRow = this.db
        .prepare(
          `SELECT COUNT(*) AS used FROM redemptions
           WHERE employee_id = ? AND reward_id = ? AND quarter = ?
             AND status IN ('PENDING', 'CANCELLING', 'COMPLETED')`,
        )
        .get(employeeId, rewardId, quarter);
      if ((quotaRow?.used as number) >= 2) {
        return { kind: "rejected", reason: "QUOTA_EXCEEDED" };
      }

      // 条件更新，防御性地保证扣减后不为负
      const decEmp = this.db
        .prepare("UPDATE employees SET points = points - ? WHERE id = ? AND points >= ?")
        .run(price, employeeId, price);
      const decReward = this.db
        .prepare("UPDATE rewards SET stock = stock - 1 WHERE id = ? AND stock >= 1")
        .run(rewardId);
      if (decEmp.changes !== 1 || decReward.changes !== 1) {
        throw new Error("resource deduction raced; rolling back");
      }

      this.db
        .prepare(
          `INSERT INTO redemptions
             (id, employee_id, reward_id, quarter, status, cancel_requested,
              attempts_started, attempts_pending, accepted_at, settled_at)
           VALUES (?, ?, ?, ?, 'PENDING', 0, 0, 0, ?, NULL)`,
        )
        .run(id, employeeId, rewardId, quarter, now);
      return { kind: "accepted", record: this.getRedemption(id)! };
    });
  }

  /** 标记取消申请；若仍有未决尝试则进入 CANCELLING。返回最新记录。 */
  markCancelRequested(id: string): RedemptionRecord {
    return this.tx(() => {
      this.db
        .prepare(
          `UPDATE redemptions
           SET cancel_requested = 1,
               status = CASE
                 WHEN status = 'PENDING' AND attempts_pending > 0 THEN 'CANCELLING'
                 ELSE status
               END
           WHERE id = ?`,
        )
        .run(id);
      return this.getRedemption(id)!;
    });
  }

  /** 登记一次尝试启动（started+1, pending+1）。 */
  startAttempt(id: string): void {
    this.db
      .prepare(
        "UPDATE redemptions SET attempts_started = attempts_started + 1, attempts_pending = attempts_pending + 1 WHERE id = ?",
      )
      .run(id);
  }

  /** 登记一次尝试返回（pending-1）。 */
  finishAttempt(id: string): void {
    this.db
      .prepare(
        "UPDATE redemptions SET attempts_pending = MAX(attempts_pending - 1, 0) WHERE id = ?",
      )
      .run(id);
  }

  /**
   * 终结兑换。仅当当前状态非终结时才生效（守卫并发回执）。
   * REJECTED/CANCELLED 时在同一事务内归还积分与库存；季度名额随状态离开占用集合自动释放。
   * 返回是否真正发生了状态迁移。
   */
  settle(id: string, status: "COMPLETED" | "REJECTED" | "CANCELLED", now: number): boolean {
    return this.tx(() => {
      const current = this.getRedemption(id);
      if (!current) throw new Error(`unknown redemption: ${id}`);
      if (TERMINAL_STATUSES.includes(current.status)) return false;

      if (status === "REJECTED" || status === "CANCELLED") {
        const reward = this.db
          .prepare("SELECT price FROM rewards WHERE id = ?")
          .get(current.rewardId);
        this.db
          .prepare("UPDATE employees SET points = points + ? WHERE id = ?")
          .run(reward!.price as number, current.employeeId);
        this.db
          .prepare("UPDATE rewards SET stock = stock + 1 WHERE id = ?")
          .run(current.rewardId);
      }
      this.db
        .prepare("UPDATE redemptions SET status = ?, settled_at = ? WHERE id = ?")
        .run(status, now, id);
      return true;
    });
  }

  /** 一致快照：单一读事务内读取全部资源与兑换状态。 */
  snapshot(takenAt: number): Snapshot {
    this.db.exec("BEGIN");
    try {
      const employees = this.db
        .prepare("SELECT id, points FROM employees ORDER BY id")
        .all()
        .map((r) => ({ id: r.id as string, availablePoints: r.points as number }));
      const rewards = this.db
        .prepare("SELECT id, price, stock FROM rewards ORDER BY id")
        .all()
        .map((r) => ({
          id: r.id as string,
          price: r.price as number,
          availableStock: r.stock as number,
        }));
      const placeholders = OCCUPYING_STATUSES.map(() => "?").join(", ");
      const quarterlyUsage = this.db
        .prepare(
          `SELECT employee_id, reward_id, quarter, COUNT(*) AS used
           FROM redemptions WHERE status IN (${placeholders})
           GROUP BY employee_id, reward_id, quarter
           ORDER BY employee_id, reward_id, quarter`,
        )
        .all(...OCCUPYING_STATUSES)
        .map((r) => ({
          employeeId: r.employee_id as string,
          rewardId: r.reward_id as string,
          quarter: r.quarter as QuarterId,
          used: r.used as number,
        }));
      const redemptions = this.db
        .prepare("SELECT * FROM redemptions ORDER BY accepted_at, id")
        .all()
        .map(toRecord);
      this.db.exec("COMMIT");
      return { takenAt, employees, rewards, quarterlyUsage, redemptions };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
