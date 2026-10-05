import { DatabaseSync } from 'node:sqlite';
import type {
  EmployeeSeed,
  RejectReason,
  RedemptionStatus,
  RedemptionView,
  RewardSeed,
  Snapshot,
} from './types.ts';

const TERMINAL_STATUSES: RedemptionStatus[] = ['completed', 'rejected', 'cancelled'];

interface RedemptionRow {
  id: string;
  employee_id: string;
  reward_id: string;
  quarter: string;
  status: string;
  attempts_started: number;
  cancel_requested: number;
}

function toView(row: RedemptionRow): RedemptionView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    rewardId: row.reward_id,
    quarter: row.quarter,
    status: row.status as RedemptionStatus,
    attemptsStarted: row.attempts_started,
    cancelRequested: row.cancel_requested === 1,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, employees: EmployeeSeed[], rewards: RewardSeed[]) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
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
        attempts_started INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_usage (
        employee_id TEXT NOT NULL,
        reward_id TEXT NOT NULL,
        quarter TEXT NOT NULL,
        used INTEGER NOT NULL CHECK (used >= 0),
        PRIMARY KEY (employee_id, reward_id, quarter)
      );
    `);
    const insertEmployee = this.db.prepare(
      'INSERT OR IGNORE INTO employees (id, points) VALUES (?, ?)',
    );
    const insertReward = this.db.prepare(
      'INSERT OR IGNORE INTO rewards (id, price, stock) VALUES (?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const employee of employees) insertEmployee.run(employee.id, employee.points);
      for (const reward of rewards) insertReward.run(reward.id, reward.price, reward.stock);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private view(id: string): RedemptionView | null {
    const row = this.db
      .prepare('SELECT * FROM redemptions WHERE id = ?')
      .get(id) as RedemptionRow | undefined;
    return row ? toView(row) : null;
  }

  getRedemption(id: string): RedemptionView | null {
    return this.view(id);
  }

  acceptRedemption(input: {
    id: string;
    employeeId: string;
    rewardId: string;
    quarter: string;
    createdAt: string;
  }): { ok: true; redemption: RedemptionView } | { ok: false; reason: RejectReason } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const employee = this.db
        .prepare('SELECT points FROM employees WHERE id = ?')
        .get(input.employeeId) as { points: number } | undefined;
      if (!employee) return this.fail('UNKNOWN_EMPLOYEE');
      const reward = this.db
        .prepare('SELECT price, stock FROM rewards WHERE id = ?')
        .get(input.rewardId) as { price: number; stock: number } | undefined;
      if (!reward) return this.fail('UNKNOWN_REWARD');
      if (employee.points < reward.price) return this.fail('INSUFFICIENT_POINTS');
      if (reward.stock < 1) return this.fail('OUT_OF_STOCK');
      const quota = this.db
        .prepare(
          'SELECT used FROM quota_usage WHERE employee_id = ? AND reward_id = ? AND quarter = ?',
        )
        .get(input.employeeId, input.rewardId, input.quarter) as { used: number } | undefined;
      if (quota && quota.used >= 2) return this.fail('QUOTA_EXCEEDED');

      this.db
        .prepare('UPDATE employees SET points = points - ? WHERE id = ?')
        .run(reward.price, input.employeeId);
      this.db.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').run(input.rewardId);
      this.db
        .prepare(
          `INSERT INTO quota_usage (employee_id, reward_id, quarter, used) VALUES (?, ?, ?, 1)
           ON CONFLICT (employee_id, reward_id, quarter) DO UPDATE SET used = used + 1`,
        )
        .run(input.employeeId, input.rewardId, input.quarter);
      this.db
        .prepare(
          `INSERT INTO redemptions
             (id, employee_id, reward_id, quarter, status, attempts_started, cancel_requested, created_at)
           VALUES (?, ?, ?, ?, 'pending', 0, 0, ?)`,
        )
        .run(input.id, input.employeeId, input.rewardId, input.quarter, input.createdAt);
      this.db.exec('COMMIT');
      return { ok: true, redemption: this.view(input.id)! };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private fail(reason: RejectReason): { ok: false; reason: RejectReason } {
    this.db.exec('ROLLBACK');
    return { ok: false, reason };
  }

  incrementAttempts(id: string): RedemptionView | null {
    this.db
      .prepare('UPDATE redemptions SET attempts_started = attempts_started + 1 WHERE id = ?')
      .run(id);
    return this.view(id);
  }

  setCancelRequested(id: string): RedemptionView | null {
    this.db.prepare('UPDATE redemptions SET cancel_requested = 1 WHERE id = ?').run(id);
    return this.view(id);
  }

  setStatus(id: string, status: RedemptionStatus): RedemptionView | null {
    this.db.prepare('UPDATE redemptions SET status = ? WHERE id = ?').run(status, id);
    return this.view(id);
  }

  complete(id: string): RedemptionView | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.view(id);
      if (current && !TERMINAL_STATUSES.includes(current.status)) {
        this.db.prepare("UPDATE redemptions SET status = 'completed' WHERE id = ?").run(id);
      }
      this.db.exec('COMMIT');
      return this.view(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  refundAndClose(id: string, finalStatus: 'rejected' | 'cancelled'): RedemptionView | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.view(id);
      if (current && !TERMINAL_STATUSES.includes(current.status)) {
        const reward = this.db
          .prepare('SELECT price FROM rewards WHERE id = ?')
          .get(current.rewardId) as { price: number };
        this.db
          .prepare('UPDATE employees SET points = points + ? WHERE id = ?')
          .run(reward.price, current.employeeId);
        this.db
          .prepare('UPDATE rewards SET stock = stock + 1 WHERE id = ?')
          .run(current.rewardId);
        this.db
          .prepare(
            `UPDATE quota_usage SET used = used - 1
             WHERE employee_id = ? AND reward_id = ? AND quarter = ?`,
          )
          .run(current.employeeId, current.rewardId, current.quarter);
        this.db
          .prepare('UPDATE redemptions SET status = ? WHERE id = ?')
          .run(finalStatus, id);
      }
      this.db.exec('COMMIT');
      return this.view(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  snapshot(): Snapshot {
    this.db.exec('BEGIN');
    try {
      const employees = this.db
        .prepare('SELECT id, points FROM employees ORDER BY id')
        .all() as unknown as { id: string; points: number }[];
      const rewards = this.db
        .prepare('SELECT id, price, stock FROM rewards ORDER BY id')
        .all() as unknown as { id: string; price: number; stock: number }[];
      const quota = this.db
        .prepare(
          'SELECT employee_id, reward_id, quarter, used FROM quota_usage ORDER BY employee_id, reward_id, quarter',
        )
        .all() as unknown as {
        employee_id: string;
        reward_id: string;
        quarter: string;
        used: number;
      }[];
      const redemptions = this.db
        .prepare('SELECT * FROM redemptions ORDER BY created_at, id')
        .all() as unknown as RedemptionRow[];
      this.db.exec('COMMIT');
      return {
        takenAt: new Date().toISOString(),
        employees: employees.map((row) => ({
          employeeId: row.id,
          availablePoints: row.points,
        })),
        rewards: rewards.map((row) => ({
          rewardId: row.id,
          price: row.price,
          availableStock: row.stock,
        })),
        quotaUsage: quota.map((row) => ({
          employeeId: row.employee_id,
          rewardId: row.reward_id,
          quarter: row.quarter,
          used: row.used,
        })),
        redemptions: redemptions.map(toView),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
