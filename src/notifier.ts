import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import { isDeliveryWindowOpen, MAX_ATTEMPTS, RETRY_DELAY_MS } from "./schedule.js";
import type {
  AttemptRecord,
  DeliverFn,
  NotificationRecord,
  NotificationStatus,
  ReceiptResult,
  SubmitNotificationInput,
} from "./types.js";

export interface NotifierOptions {
  /** SQLite file path, or ":memory:". */
  dbPath: string;
  deliver: DeliverFn;
  /** Issued for each new attempt; must return a unique value per call. */
  nextAttemptId?: () => string;
}

interface NotificationRow {
  id: string;
  body: string;
  recipient: string;
  not_before: number;
  critical: number;
  status: string;
  created_at: number;
  confirmed_at: number | null;
}

interface AttemptRow {
  id: string;
  notification_id: string;
  seq: number;
  first_started_at: number;
  call_ended: number;
  call_ended_at: number | null;
}

function toNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    body: row.body,
    recipient: row.recipient,
    notBefore: row.not_before,
    critical: row.critical === 1,
    status: row.status as NotificationStatus,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

function toAttempt(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    notificationId: row.notification_id,
    seq: row.seq,
    firstStartedAt: row.first_started_at,
    callEnded: row.call_ended === 1,
    callEndedAt: row.call_ended_at,
  };
}

/**
 * Reliable delivery & acknowledgement library for archive notifications.
 * All expiry processing is driven by advance(now); `now` is a
 * caller-provided monotonic non-decreasing UTC epoch-millis timestamp.
 */
export class ArchiveNotifier {
  private readonly db: DatabaseSync;
  private readonly deliver: DeliverFn;
  private readonly nextAttemptId: () => string;
  private queue: Promise<void> = Promise.resolve();
  private lastNow = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(options: NotifierOptions) {
    this.db = openDatabase(options.dbPath);
    this.deliver = options.deliver;
    this.nextAttemptId = options.nextAttemptId ?? (() => randomUUID());
  }

  /**
   * Submit a notification. Resubmitting the same id with identical content
   * is a no-op and never resets delivery progress; conflicting content throws.
   */
  submitNotification(input: SubmitNotificationInput, now: number): void {
    this.assertOpen();
    const existing = this.db
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(input.id) as NotificationRow | undefined;
    if (existing) {
      const same =
        existing.body === input.body &&
        existing.recipient === input.recipient &&
        existing.not_before === input.notBefore &&
        existing.critical === (input.critical ? 1 : 0);
      if (!same) {
        throw new Error(
          `notification ${input.id} already exists with different content`,
        );
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO notifications (id, body, recipient, not_before, critical, status, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(input.id, input.body, input.recipient, input.notBefore, input.critical ? 1 : 0, now);
  }

  /** Drive due deliveries, crash replays, retries and exhaustion up to `now`. */
  advance(now: number): Promise<void> {
    this.assertOpen();
    const effective = Math.max(now, this.lastNow);
    this.lastNow = effective;
    const run = this.queue.then(() => this.advanceInner(effective));
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Submit a receipt referencing any started attempt of the message.
   * Duplicate receipt ids are ignored; unknown attempt ids are invalid.
   * A valid receipt confirms the message even after exhaustion.
   */
  submitReceipt(receiptId: string, attemptId: string, now: number): ReceiptResult {
    this.assertOpen();
    const dupe = this.db.prepare("SELECT id FROM receipts WHERE id = ?").get(receiptId);
    if (dupe) return { kind: "duplicate" };
    const attempt = this.db
      .prepare("SELECT * FROM attempts WHERE id = ?")
      .get(attemptId) as AttemptRow | undefined;
    if (!attempt) return { kind: "invalid" };
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO receipts (id, attempt_id, notification_id, received_at) VALUES (?, ?, ?, ?)",
        )
        .run(receiptId, attemptId, attempt.notification_id, now);
      this.db
        .prepare("UPDATE notifications SET status = 'confirmed', confirmed_at = ? WHERE id = ?")
        .run(now, attempt.notification_id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { kind: "confirmed", notificationId: attempt.notification_id };
  }

  getNotification(id: string): NotificationRecord | null {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
      | NotificationRow
      | undefined;
    return row ? toNotification(row) : null;
  }

  listAttempts(notificationId: string): AttemptRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT * FROM attempts WHERE notification_id = ? ORDER BY seq ASC")
      .all(notificationId) as unknown as AttemptRow[];
    return rows.map(toAttempt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("notifier is closed");
  }

  private async advanceInner(now: number): Promise<void> {
    const pending = this.db
      .prepare("SELECT * FROM notifications WHERE status = 'pending' ORDER BY created_at ASC, id ASC")
      .all() as unknown as NotificationRow[];
    for (const row of pending) {
      await this.processOne(toNotification(row), now);
    }
  }

  private async processOne(notification: NotificationRecord, now: number): Promise<void> {
    // A receipt may have landed while a previous delivery was in flight.
    if (this.currentStatus(notification.id) !== "pending") return;

    const latest = this.latestAttempt(notification.id);

    if (latest && !latest.callEnded) {
      // Crash replay: the delivery call's end state was never saved.
      // Re-invoke with the SAME attempt id and first start time; the attempt
      // count must not grow and we must not skip to the next attempt.
      if (!this.mayStart(notification, now)) return;
      await this.runDelivery(notification, latest, now);
      return;
    }

    if (!latest) {
      // First delivery.
      if (now < notification.notBefore) return;
      if (!this.mayStart(notification, now)) return;
      const attempt = this.createAttempt(notification.id, 1, now);
      await this.runDelivery(notification, attempt, now);
      return;
    }

    // Latest attempt's call end state is durably saved: never replay it.
    const elapsed = now - latest.firstStartedAt;
    if (elapsed < RETRY_DELAY_MS) return;

    if (latest.seq >= MAX_ATTEMPTS) {
      // Fourth attempt satisfied the same conditions without confirmation.
      this.db
        .prepare("UPDATE notifications SET status = 'exhausted' WHERE id = ? AND status = 'pending'")
        .run(notification.id);
      return;
    }

    if (!this.mayStart(notification, now)) return;
    const attempt = this.createAttempt(notification.id, latest.seq + 1, now);
    await this.runDelivery(notification, attempt, now);
  }

  private mayStart(notification: NotificationRecord, now: number): boolean {
    if (now < notification.notBefore) return false;
    return isDeliveryWindowOpen(now, notification.critical);
  }

  private currentStatus(id: string): NotificationStatus | null {
    const row = this.db.prepare("SELECT status FROM notifications WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    return row ? (row.status as NotificationStatus) : null;
  }

  private latestAttempt(notificationId: string): AttemptRecord | null {
    const row = this.db
      .prepare("SELECT * FROM attempts WHERE notification_id = ? ORDER BY seq DESC LIMIT 1")
      .get(notificationId) as AttemptRow | undefined;
    return row ? toAttempt(row) : null;
  }

  private createAttempt(notificationId: string, seq: number, now: number): AttemptRecord {
    const id = this.nextAttemptId();
    this.db
      .prepare(
        `INSERT INTO attempts (id, notification_id, seq, first_started_at, call_ended, call_ended_at)
         VALUES (?, ?, ?, ?, 0, NULL)`,
      )
      .run(id, notificationId, seq, now);
    return {
      id,
      notificationId,
      seq,
      firstStartedAt: now,
      callEnded: false,
      callEndedAt: null,
    };
  }

  /**
   * Invoke the delivery function, then durably save the call's end state.
   * Normal return or throw both count as "call ended"; neither means
   * user confirmation. Never touches the notification's status, so a
   * receipt confirmed during the call is never overwritten.
   */
  private async runDelivery(
    notification: NotificationRecord,
    attempt: AttemptRecord,
    now: number,
  ): Promise<void> {
    try {
      await this.deliver(notification.body, notification.id, attempt.id);
    } catch {
      // A throwing delivery function still ends the call; retry policy applies.
    }
    this.db
      .prepare("UPDATE attempts SET call_ended = 1, call_ended_at = ? WHERE id = ?")
      .run(now, attempt.id);
  }
}
