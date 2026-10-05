import { DatabaseSync } from "node:sqlite";
import type { DeliveryResult, NotificationState, NotificationStatus, Receiver } from "./types.js";

export interface QueueOptions {
  /** SQLite 文件路径，或 ":memory:" */
  dbPath: string;
  receiver: Receiver;
}

/** 最大尝试次数 */
export const MAX_ATTEMPTS = 5;

/** 第 attempt 次（1..4）失败后的退避毫秒数：1、2、4、8 秒 */
export function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

interface NotificationRow {
  id: string;
  message: string;
  next_attempt: number;
  next_attempt_at: number;
  done: number;
  failed: number;
}

/** 基于 SQLite 的可靠通知投递队列（单发送执行者） */
export class NotificationQueue {
  private readonly db: DatabaseSync;
  private readonly receiver: Receiver;

  constructor(options: QueueOptions) {
    this.db = new DatabaseSync(options.dbPath);
    this.receiver = options.receiver;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        next_attempt INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS read_acks (
        id TEXT PRIMARY KEY
      );
    `);
  }

  /** 入队；同一 id 重复入队不重置尝试次数、退避或终态 */
  enqueue(id: string, message: string, now: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO notifications (id, message, next_attempt, next_attempt_at, done, failed) VALUES (?, ?, 1, ?, 0, 0)",
      )
      .run(id, message, now);
  }

  /** 推进所有到期投递；迟到推进只处理已到期尝试，不提前投递 */
  async advance(now: number): Promise<void> {
    const due = this.db
      .prepare(
        "SELECT id, message, next_attempt, next_attempt_at, done, failed FROM notifications WHERE done = 0 AND next_attempt_at <= ? ORDER BY id",
      )
      .all(now) as unknown as NotificationRow[];
    for (const row of due) {
      await this.advanceOne(row, now);
    }
  }

  private async advanceOne(row: NotificationRow, now: number): Promise<void> {
    const attempt = row.next_attempt;
    // 恢复：优先采用接收方已落地但队列尚未确认的结果
    let result: DeliveryResult | null = this.receiver.getResult(row.id, attempt);
    if (!result) {
      result = await this.receiver.deliver(row.id, attempt, row.message, now);
    }
    if (result.ok) {
      this.db
        .prepare("UPDATE notifications SET next_attempt = ?, done = 1 WHERE id = ?")
        .run(attempt + 1, row.id);
      return;
    }
    if (attempt >= MAX_ATTEMPTS) {
      this.db
        .prepare("UPDATE notifications SET next_attempt = ?, done = 1, failed = 1 WHERE id = ?")
        .run(attempt + 1, row.id);
      return;
    }
    // 退避从结果落地时间起算，而非恢复或推进时间
    this.db
      .prepare("UPDATE notifications SET next_attempt = ?, next_attempt_at = ? WHERE id = ?")
      .run(attempt + 1, result.landedAt + backoffMs(attempt), row.id);
  }

  /** 接收阅读确认（可先于队列获知投递成功，可重复） */
  ackRead(id: string): void {
    this.db.prepare("INSERT OR IGNORE INTO read_acks (id) VALUES (?)").run(id);
  }

  /** 查询通知状态；不存在返回 null */
  getStatus(id: string): NotificationState | null {
    const row = this.db
      .prepare(
        "SELECT id, message, next_attempt, next_attempt_at, done, failed FROM notifications WHERE id = ?",
      )
      .get(id) as NotificationRow | undefined;
    if (!row) {
      return null;
    }
    const acked = this.db.prepare("SELECT 1 AS x FROM read_acks WHERE id = ?").get(id);
    let status: NotificationStatus;
    if (acked) {
      status = "read";
    } else if (row.done) {
      status = row.failed ? "failed" : "delivered";
    } else {
      status = "queued";
    }
    const attempts = Math.min(row.next_attempt - 1, MAX_ATTEMPTS);
    return {
      id: row.id,
      status,
      attempts,
      nextAttemptAt: row.done ? null : row.next_attempt_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
