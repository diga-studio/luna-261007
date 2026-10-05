import { DatabaseSync } from "node:sqlite";
import type { DeliveryResult, Receiver } from "./types.js";

/** 决定某次投递成功与否的行为函数 */
export type DeliveryBehavior = (notificationId: string, attempt: number) => boolean;

export interface LocalReceiverOptions {
  /** SQLite 文件路径，或 ":memory:" */
  dbPath: string;
  behavior: DeliveryBehavior;
}

interface ResultRow {
  ok: number;
  landed_at: number;
}

/**
 * 本机接收方：独立持久化投递结果与收件箱消息。
 * 同一 (id, attempt) 重复调用返回首次落地结果及其落地时间；
 * 成功时保存实际可读消息，同一通知最多保存一条。
 */
export class LocalReceiver implements Receiver {
  private readonly db: DatabaseSync;
  private readonly behavior: DeliveryBehavior;

  constructor(options: LocalReceiverOptions) {
    this.db = new DatabaseSync(options.dbPath);
    this.behavior = options.behavior;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        notification_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        landed_at INTEGER NOT NULL,
        PRIMARY KEY (notification_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS inbox (
        notification_id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        landed_at INTEGER NOT NULL
      );
    `);
  }

  deliver(
    notificationId: string,
    attempt: number,
    message: string,
    now: number,
  ): Promise<DeliveryResult> {
    const existing = this.getResult(notificationId, attempt);
    if (existing) {
      return Promise.resolve(existing);
    }
    const ok = this.behavior(notificationId, attempt);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO results (notification_id, attempt, ok, landed_at) VALUES (?, ?, ?, ?)",
        )
        .run(notificationId, attempt, ok ? 1 : 0, now);
      if (ok) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO inbox (notification_id, message, landed_at) VALUES (?, ?, ?)",
          )
          .run(notificationId, message, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const stored = this.getResult(notificationId, attempt);
    if (!stored) {
      throw new Error("receiver failed to persist delivery result");
    }
    return Promise.resolve(stored);
  }

  getResult(notificationId: string, attempt: number): DeliveryResult | null {
    const row = this.db
      .prepare(
        "SELECT ok, landed_at FROM results WHERE notification_id = ? AND attempt = ?",
      )
      .get(notificationId, attempt) as ResultRow | undefined;
    if (!row) {
      return null;
    }
    return { ok: row.ok !== 0, landedAt: row.landed_at };
  }

  /** 读取收件箱中某通知的消息；无则 null */
  getMessage(notificationId: string): string | null {
    const row = this.db
      .prepare("SELECT message FROM inbox WHERE notification_id = ?")
      .get(notificationId) as { message: string } | undefined;
    return row ? row.message : null;
  }

  /** 收件箱消息总数 */
  messageCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM inbox")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
