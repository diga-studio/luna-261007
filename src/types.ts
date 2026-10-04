/** A single hourly metric data point. */
export interface MetricInput {
  /** Resource identifier. */
  resource: string;
  /** UTC integer hour the metric belongs to. Must be earlier than current hour T. */
  hour: number;
  /** Monotonic revision of this (resource, hour) series. Highest wins. */
  revision: number;
  /** CPU utilization, integer in [0, 10000], unit: 1/100 of a percent. */
  utilization: number;
}

/** Aggregate statistics over an hour range. */
export interface StatsResult {
  /** Number of hours that have data (missing hours are not zero). */
  hours: number;
  /** Sum of utilization over the valid hours. */
  totalUtilization: number;
  /** Maximum utilization over the valid hours; 0 when no data. */
  maxUtilization: number;
}

/** Crash-injection hook used only by tests to simulate abrupt termination. */
export type CrashHook = (point: string) => void;

export interface TrimStackOptions {
  /** Storage directory. Created when missing. */
  dir: string;
  /** Initial current hour T (UTC integer hour). Required on first creation; ignored afterwards. */
  initialT?: number;
  /** Test-only crash hook invoked at named internal points. */
  crashHook?: CrashHook;
}

/** Hours of hot retention: metrics newer than T-30d stay updatable in SQLite. */
export const HOT_HOURS = 30 * 24;
/** Hours of total retention: metrics newer than T-90d are queryable. */
export const RETENTION_HOURS = 90 * 24;
/** Cold archive window size in hours (aligned to absolute hour 0). */
export const ARCHIVE_WINDOW_HOURS = 24;
