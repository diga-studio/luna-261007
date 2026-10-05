import { DatabaseSync } from "node:sqlite";
import type { DeliveryResult, NotificationState, NotificationStatus, Receiver } from "./types.js";

const MAX_ATTEMPTS = 5;
/** Backoff after a failed attempt, indexed by attempt number (1-based). */
const BACKOFF_MS: readonly number[] = [0, 1_000, 2_000, 4_000, 8_000];

interface NotificationRow {
  id: string;
  body: string;
  status: NotificationStatus;
  attempt_count: number;
  next_attempt_at: number | null;
}

/**
 * Durable notification queue backed by SQLite. Single delivery executor;
 * enqueue/read-ack may happen while a delivery is still in flight.
 *
 * Crash model: the receiver commits its result before deliver() returns,
 * while the queue records the outcome afterwards. A process exit in between
 * is healed on the next advance() by adopting the receiver's persisted
 * result (with its original landing time) instead of re-delivering.
 */
export class NotificationQueue {
  private readonly db: DatabaseSync;
  private readonly receiver: Receiver;
  private chain: Promise<void> = Promise.resolve();

  constructor(dbPath: string, receiver: Receiver) {
    this.db = new DatabaseSync(dbPath);
    this.receiver = receiver;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        next_attempt_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Enqueue a notification. Re-enqueueing an existing id is a no-op and never
   * resets attempts, backoff, or a reached terminal state.
   */
  enqueue(id: string, body: string, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications
           (id, body, status, attempt_count, next_attempt_at, created_at)
         VALUES (?, ?, 'queued', 0, ?, ?)`,
      )
      .run(id, body, now, now);
  }

  /**
   * Run every attempt that is due at `now`. Never delivers early; adopts
   * results the receiver already persisted before a crash. Concurrent
   * advance() calls are serialized.
   */
  advance(now: number): Promise<void> {
    const run = this.chain.then(() => this.advanceDue(now));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Record a read acknowledgement. Idempotent; once read, the notification
   * can never go back to "delivered" or "queued".
   */
  ackRead(id: string): void {
    this.db
      .prepare(
        "UPDATE notifications SET status = 'read', next_attempt_at = NULL WHERE id = ? AND status != 'read'",
      )
      .run(id);
  }

  /** Current durable state of one notification, or undefined if unknown. */
  get(id: string): NotificationState | undefined {
    const row = this.getRow(id);
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      body: row.body,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
    };
  }

  close(): void {
    this.db.close();
  }

  private getRow(id: string): NotificationRow | undefined {
    return this.db
      .prepare(
        "SELECT id, body, status, attempt_count, next_attempt_at FROM notifications WHERE id = ?",
      )
      .get(id) as NotificationRow | undefined;
  }

  private async advanceDue(now: number): Promise<void> {
    const due = this.db
      .prepare(
        `SELECT id FROM notifications
         WHERE status = 'queued' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
         ORDER BY created_at, id`,
      )
      .all(now) as Array<{ id: string }>;
    for (const { id } of due) {
      await this.processOne(id);
    }
    // Read notifications are terminal, but a result may have landed at the
    // receiver before the queue recorded it: reconcile the attempt count
    // without ever starting a new delivery or changing the status.
    const reads = this.db
      .prepare("SELECT id FROM notifications WHERE status = 'read' ORDER BY created_at, id")
      .all() as Array<{ id: string }>;
    for (const { id } of reads) {
      await this.reconcileRead(id);
    }
  }

  private async reconcileRead(id: string): Promise<void> {
    for (;;) {
      const row = this.getRow(id);
      if (row === undefined || row.status !== "read") {
        return;
      }
      const attempt = row.attempt_count + 1;
      const result = await this.receiver.getResult(id, attempt);
      if (result === undefined) {
        return;
      }
      this.applyResult(id, attempt, result);
    }
  }

  private async processOne(id: string): Promise<void> {
    const row = this.getRow(id);
    if (row === undefined || row.status !== "queued") {
      return;
    }
    const attempt = row.attempt_count + 1;
    let result: DeliveryResult | undefined = await this.receiver.getResult(id, attempt);
    if (result === undefined) {
      result = await this.receiver.deliver(id, attempt, row.body);
    }
    this.applyResult(id, attempt, result);
  }

  private applyResult(id: string, attempt: number, result: DeliveryResult): void {
    const row = this.getRow(id);
    if (row === undefined || attempt <= row.attempt_count) {
      return;
    }
    if (row.status === "read") {
      // A read ack landed while this attempt was in flight (or before the
      // queue learned the outcome): record the attempt, never downgrade.
      this.db
        .prepare("UPDATE notifications SET attempt_count = ?, next_attempt_at = NULL WHERE id = ?")
        .run(attempt, id);
      return;
    }
    if (row.status !== "queued") {
      return;
    }
    let status: NotificationStatus;
    let nextAttemptAt: number | null;
    if (result.ok) {
      status = "delivered";
      nextAttemptAt = null;
    } else if (attempt >= MAX_ATTEMPTS) {
      status = "failed";
      nextAttemptAt = null;
    } else {
      status = "queued";
      nextAttemptAt = result.landedAt + BACKOFF_MS[attempt];
    }
    this.db
      .prepare(
        "UPDATE notifications SET status = ?, attempt_count = ?, next_attempt_at = ? WHERE id = ?",
      )
      .run(status, attempt, nextAttemptAt, id);
  }
}
