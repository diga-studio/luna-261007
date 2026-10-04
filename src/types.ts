/** Notification lifecycle status. */
export type NotificationStatus = "pending" | "confirmed" | "exhausted";

/** Input for submitting a new notification. */
export interface SubmitNotificationInput {
  /** Business-unique identifier; resubmission with the same id is a no-op. */
  id: string;
  body: string;
  recipient: string;
  /** Earliest delivery time, epoch milliseconds (UTC). */
  notBefore: number;
  /** Critical notifications may be delivered outside the 08:00-18:00 UTC window. */
  critical: boolean;
}

/** Persisted notification record. */
export interface NotificationRecord {
  id: string;
  body: string;
  recipient: string;
  notBefore: number;
  critical: boolean;
  status: NotificationStatus;
  createdAt: number;
  confirmedAt: number | null;
}

/** Persisted delivery attempt record. */
export interface AttemptRecord {
  /** Unique attempt identifier, issued before the delivery call starts. */
  id: string;
  notificationId: string;
  /** 1-based sequence number of the attempt. */
  seq: number;
  /** First start time of this attempt; never changes on replay. */
  firstStartedAt: number;
  /** Whether the delivery call's end state has been durably saved. */
  callEnded: boolean;
  callEndedAt: number | null;
}

/**
 * Caller-provided in-process delivery function.
 * Returning normally or throwing does NOT mean the user confirmed;
 * only a separately submitted valid receipt confirms.
 */
export type DeliverFn = (
  body: string,
  messageId: string,
  attemptId: string,
) => void | Promise<void>;

export type ReceiptResult =
  | { kind: "confirmed"; notificationId: string }
  | { kind: "duplicate" }
  | { kind: "invalid" };
