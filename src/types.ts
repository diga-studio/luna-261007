/** A single raw metric record parsed from the metrics file. */
export interface MetricRecord {
  /** Device identifier, e.g. "gw-01". */
  readonly deviceId: string;
  /** Integer millisecond timestamp. */
  readonly timestampMs: number;
  /** Integer latency in microseconds, 0..10_000_000. */
  readonly latencyUs: number;
}

/** Options for a statistics query. */
export interface QueryOptions {
  /** Range start in integer milliseconds, inclusive. Must be < endMs. */
  readonly startMs: number;
  /** Range end in integer milliseconds, exclusive. */
  readonly endMs: number;
  /** Single device id. Omit or pass undefined to query all devices. */
  readonly deviceId?: string;
}

/** Statistics over the records matching a query. */
export interface QueryStats {
  /** Number of matching records. */
  readonly count: number;
  /** Inferences per second: count divided by the query range length in seconds. */
  readonly throughputPerSec: number;
  /** Exact p50 latency in microseconds, or null when count is 0. */
  readonly p50: number | null;
  /** Exact p95 latency in microseconds, or null when count is 0. */
  readonly p95: number | null;
  /** Exact p99 latency in microseconds, or null when count is 0. */
  readonly p99: number | null;
}

/**
 * An immutable, read-only dataset produced by one import.
 * Data never changes while queries run; datasets are independent.
 */
export interface Dataset {
  /** Total number of imported records. */
  readonly recordCount: number;
  /** All device ids present in the dataset. */
  readonly deviceIds: readonly string[];
  /** Run a statistics query over a time range and one or all devices. */
  query(options: QueryOptions): QueryStats;
}
