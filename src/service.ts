import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  DecisionInput,
  Grant,
  GrantAvailability,
  ReviewCycle,
  ReviewItem,
} from "./types.js";

const CYCLE_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const CLOCK_KEY = "last_clock_ms";

interface GrantRow {
  id: string;
  user_id: string;
  database_id: string;
  role: string;
  revoked: number;
  granted_at: number;
  revoked_at: number | null;
}

interface ItemRow {
  id: string;
  cycle_id: string;
  grant_id: string;
  status: string;
  decided_at: number | null;
}

function toItem(row: ItemRow): ReviewItem {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    grantId: row.grant_id,
    status: row.status as ReviewItem["status"],
    decidedAt: row.decided_at,
  };
}

/**
 * 权限复核服务。所有 now 参数为调用方提供的 UTC 毫秒时间，
 * 同一实例内要求单调不回退。
 */
export class ReviewService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 校验并推进时钟：拒绝回退的 now。 */
  private advanceClock(now: number): void {
    if (!Number.isFinite(now)) {
      throw new Error(`invalid clock value: ${now}`);
    }
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(CLOCK_KEY) as { value: number } | undefined;
    const last = row?.value ?? null;
    if (last !== null && now < last) {
      throw new Error(`clock regressed: ${now} < ${last}`);
    }
    if (last === null || now > last) {
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(CLOCK_KEY, now);
    }
  }

  /** 授权登记：同一 (user, database, role) 组合最多一个未撤销实例。 */
  grant(
    userId: string,
    databaseId: string,
    role: string,
    now: number,
  ): Grant {
    this.advanceClock(now);
    const id = randomUUID();
    try {
      this.db
        .prepare(
          "INSERT INTO grants (id, user_id, database_id, role, revoked, granted_at) " +
            "VALUES (?, ?, ?, ?, 0, ?)",
        )
        .run(id, userId, databaseId, role, now);
    } catch (err) {
      if (err instanceof Error && err.message.includes("idx_grants_active_combo")) {
        throw new Error(
          `an unrevoked grant already exists for (${userId}, ${databaseId}, ${role})`,
        );
      }
      throw err;
    }
    return {
      id,
      userId,
      databaseId,
      role,
      revoked: false,
      grantedAt: now,
      revokedAt: null,
    };
  }

  /** 开启复核周期：纳入该数据库全部未撤销实例（含已挂起）。 */
  openCycle(databaseId: string, now: number): ReviewCycle {
    this.advanceClock(now);
    const id = randomUUID();
    const deadline = now + CYCLE_DURATION_MS;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO review_cycles (id, database_id, opened_at, deadline) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(id, databaseId, now, deadline);
      // 快照当前未撤销实例；此后周期范围不再变化
      this.db
        .prepare(
          "INSERT INTO review_items (id, cycle_id, grant_id, status) " +
            "SELECT lower(hex(randomblob(16))), ?, id, 'pending' " +
            "FROM grants WHERE database_id = ? AND revoked = 0",
        )
        .run(id, databaseId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { id, databaseId, openedAt: now, deadline };
  }

  /** 批量提交决定（可跨周期，整体原子）。 */
  submitDecisions(decisions: DecisionInput[], now: number): void {
    this.advanceClock(now);
    this.db.exec("BEGIN");
    try {
      const getItem = this.db.prepare(
        "SELECT id, cycle_id, grant_id, status, decided_at FROM review_items WHERE id = ?",
      );
      const decideItem = this.db.prepare(
        "UPDATE review_items SET status = ?, decided_at = ? WHERE id = ?",
      );
      const revokeGrant = this.db.prepare(
        "UPDATE grants SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0",
      );
      for (const { itemId, decision } of decisions) {
        const row = getItem.get(itemId) as ItemRow | undefined;
        if (!row) {
          throw new Error(`review item not found: ${itemId}`);
        }
        const target = decision === "confirm" ? "confirmed" : "revoked";
        if (row.status !== "pending") {
          // 重复提交相同决定：幂等成功；相反决定：整个批次失败
          if (row.status === target) continue;
          throw new Error(
            `review item ${itemId} already ${row.status}, cannot change to ${target}`,
          );
        }
        decideItem.run(target, now, itemId);
        if (decision === "revoke") {
          // 撤销决定永久撤销绑定的实例
          revokeGrant.run(now, row.grant_id);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 读取某授权实例在 now 时刻的有效性。 */
  getGrantAvailability(grantId: string, now: number): GrantAvailability {
    this.advanceClock(now);
    const row = this.db
      .prepare(
        "SELECT id, user_id, database_id, role, revoked, granted_at, revoked_at " +
          "FROM grants WHERE id = ?",
      )
      .get(grantId) as GrantRow | undefined;
    if (!row) {
      throw new Error(`grant not found: ${grantId}`);
    }
    if (row.revoked === 1) {
      return { grantId, status: "revoked", suspendingItemIds: [] };
    }
    // 已逾期待审条目：截止瞬间（deadline <= now）仍未决定的条目
    const overdue = this.db
      .prepare(
        "SELECT i.id FROM review_items i " +
          "JOIN review_cycles c ON c.id = i.cycle_id " +
          "WHERE i.grant_id = ? AND i.status = 'pending' AND c.deadline <= ?",
      )
      .all(grantId, now) as unknown as Array<{ id: string }>;
    const suspendingItemIds = overdue.map((r) => r.id);
    return {
      grantId,
      status: suspendingItemIds.length > 0 ? "suspended" : "active",
      suspendingItemIds,
    };
  }

  /** 读取周期内全部条目。 */
  listCycleItems(cycleId: string): ReviewItem[] {
    const rows = this.db
      .prepare(
        "SELECT id, cycle_id, grant_id, status, decided_at FROM review_items " +
          "WHERE cycle_id = ? ORDER BY rowid",
      )
      .all(cycleId) as unknown as ItemRow[];
    return rows.map(toItem);
  }
}
