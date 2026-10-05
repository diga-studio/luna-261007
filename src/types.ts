/** A single transaction record. */
export interface Transaction {
  /** Unique transaction identifier. Duplicates carry identical content. */
  transaction_id: string;
  /** Terminal that produced the transaction. */
  terminal_id: string;
  /** UTC timestamp in milliseconds. */
  timestamp: number;
  /** Outcome of the transaction. */
  status: "failed" | "success";
}

/** Kind of alert-state transition. */
export type AlertChangeType = "start" | "end";

/**
 * A single alert-state transition for one terminal.
 * `timestamp` is the exact boundary where the state flipped:
 * the first moment the failure rate strictly exceeded 5% ("start"),
 * or the first moment it no longer did ("end").
 */
export interface AlertChange {
  terminal_id: string;
  type: AlertChangeType;
  timestamp: number;
}
