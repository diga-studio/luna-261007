/** Terminal and in-flight states of a queued notification. */
export type NotificationStatus = "queued" | "delivered" | "read" | "failed";

/** Durable, caller-visible state of one notification. */
export interface NotificationState {
  /** Business notification id (unique). */
  id: string;
  /** Fully rendered message body, provided by the caller at enqueue time. */
  body: string;
  status: NotificationStatus;
  /** Number of attempts whose result has been recorded by the queue. */
  attemptCount: number;
  /** Earliest business time (ms) at which the next attempt may run; null when none is scheduled. */
  nextAttemptAt: number | null;
}

/** A delivery result as persisted by the receiver. */
export interface DeliveryResult {
  ok: boolean;
  /** Business time (ms) at which the receiver first persisted this result. */
  landedAt: number;
}

/**
 * Local receiver implemented by the caller. It persists every result
 * independently of the queue and is idempotent per (notificationId, attempt).
 */
export interface Receiver {
  /**
   * Persist and return the result for this attempt. Repeated calls with the
   * same (notificationId, attempt) must return the originally persisted
   * result and landing time. On success the receiver stores the readable
   * message, keeping at most one message per notification.
   */
  deliver(
    notificationId: string,
    attempt: number,
    message: string,
  ): DeliveryResult | Promise<DeliveryResult>;
  /**
   * Return the already persisted result for this attempt, or undefined when
   * the attempt never landed (e.g. the process exited mid-delivery).
   */
  getResult(
    notificationId: string,
    attempt: number,
  ): DeliveryResult | undefined | Promise<DeliveryResult | undefined>;
}
