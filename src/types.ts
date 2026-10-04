/** A single hourly metric sample. */
export interface MetricRecord {
  /** Resource identifier. */
  resource: string;
  /** UTC integer hour (ms-free epoch hour). */
  hour: number;
  /** Monotonic revision of the sample for the same (resource, hour). */
  revision: number;
  /** CPU utilization, integer 0..10000, unit: 1/100 of a percent. */
  cpu: number;
}

/** Aggregated statistics over a query range. */
export interface HourlyStats {
  /** Number of hours that have data inside the retained range. */
  hours: number;
  /** Sum of cpu over the effective hours. */
  totalCpu: number;
  /** Max cpu over the effective hours; 0 when no data. */
  maxCpu: number;
}

/** Test-only hooks fired at crash-relevant points; each may throw to simulate a kill. */
export interface CrashHooks {
  onWriteBatchBeforeCommit?: () => void;
  onMaintainTempFileWritten?: () => void;
  onMaintainFileRenamed?: () => void;
  onMaintainBeforeCommit?: () => void;
  onMaintainAfterCommit?: () => void;
  onMaintainDuringCleanup?: () => void;
  onRecoverDuringCleanup?: () => void;
}

export interface StoreOptions {
  /** Required when the store is created for the first time; ignored-with-check on reopen. */
  initialHour?: number;
  /** Test-only crash simulation hooks. */
  crashHooks?: CrashHooks;
}
