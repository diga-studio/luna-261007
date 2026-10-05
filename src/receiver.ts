import { DatabaseSync } from "node:sqlite";
import type { DeliveryResult, Receiver } from "./types.js";

/** Options for the bundled SQLite-backed local receiver. */
export interface LocalReceiverOptions {
  /** Monotonic non-decreasing business clock in integer milliseconds. */
  now: () => number;
  /** Optional failure injector: return true to make this attempt fail. */
  shouldFail?: (notificationId: string, attempt: number) => boolean;
}

/** A message as persisted in the receiver's inbox. */
export interface InboxMessage {
  notificationId: string;
  body: string;
  landedAt: number;
}

interface ResultRow {
  ok: number;
  landed_at: number;
}

interface MessageRow {
  notification_id: string;
  body: string;
  landed_at: number;
}

/**
 * File-backed local receiver. Persists one result per (notificationId,
 * attempt) and at most one inbox message per notification, in SQLite.
 * All writes are committed before deliver() returns, so a process exit
 * after the commit but before the caller resumes is fully recoverable.
 */
export class LocalReceiver implements Receiver {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly shouldFail?: (notificationId: string, attempt: number) => boolean;

  constructor(dbPath: string, options: LocalReceiverOptions) {
    this.db = new DatabaseSync(dbPath);
    this.now = options.now;
    this.shouldFail = options.shouldFail;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        notification_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        landed_at INTEGER NOT NULL,
        PRIMARY KEY (notification_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS messages (
        notification_id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        landed_at INTEGER NOT NULL
      );
    `);
  }

  deliver(notificationId: string, attempt: number, message: string): DeliveryResult {
    const existing = this.getResult(notificationId, attempt);
    if (existing !== undefined) {
      return existing;
    }
    const ok = !(this.shouldFail?.(notificationId, attempt) ?? false);
    const landedAt = this.now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO results (notification_id, attempt, ok, landed_at) VALUES (?, ?, ?, ?)",
        )
        .run(notificationId, attempt, ok ? 1 : 0, landedAt);
      if (ok) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO messages (notification_id, body, landed_at) VALUES (?, ?, ?)",
          )
          .run(notificationId, message, landedAt);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const persisted = this.getResult(notificationId, attempt);
    if (persisted === undefined) {
      throw new Error("receiver failed to persist delivery result");
    }
    return persisted;
  }

  getResult(notificationId: string, attempt: number): DeliveryResult | undefined {
    const row = this.db
      .prepare(
        "SELECT ok, landed_at FROM results WHERE notification_id = ? AND attempt = ?",
      )
      .get(notificationId, attempt) as ResultRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { ok: row.ok !== 0, landedAt: row.landed_at };
  }

  /** Read the persisted inbox message for a notification, if any. */
  getMessage(notificationId: string): InboxMessage | undefined {
    const row = this.db
      .prepare("SELECT notification_id, body, landed_at FROM messages WHERE notification_id = ?")
      .get(notificationId) as MessageRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { notificationId: row.notification_id, body: row.body, landedAt: row.landed_at };
  }

  /** Number of inbox messages currently persisted (for assertions). */
  countMessages(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
