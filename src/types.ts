/** A single raw inference metric record. */
export interface MetricRecord {
  deviceId: string;
  /** Integer millisecond timestamp. */
  timestampMs: number;
  /** Integer microseconds, 0..10_000_000. */
  latencyUs: number;
}

/** Query over a half-open time range [startMs, endMs). */
export interface QueryOptions {
  /** Inclusive range start, integer milliseconds. */
  startMs: number;
  /** Exclusive range end, integer milliseconds. Must be > startMs. */
  endMs: number;
  /** Single device id. Omit to query all devices with equal weight per record. */
  deviceId?: string;
}

export interface QueryStats {
  /** Number of matched records. */
  count: number;
  /** count / (range length in seconds). 0 when count is 0. */
  throughputPerSec: number;
  /** Exact p50 latency in microseconds, null when no records match. */
  p50: number | null;
  /** Exact p95 latency in microseconds, null when no records match. */
  p95: number | null;
  /** Exact p99 latency in microseconds, null when no records match. */
  p99: number | null;
}

/** A read-only dataset built by one import. */
export interface Dataset {
  readonly recordCount: number;
  readonly deviceIds: readonly string[];
  query(options: QueryOptions): QueryStats;
}
