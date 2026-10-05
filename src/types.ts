/** A single mapped/converted sample record entering the pipeline. */
export interface SampleRecord {
  /** Identifies the logical sample; corrections share the same recordId. */
  readonly recordId: string;
  /** Non-negative integer version; only the highest revision per recordId is effective. */
  readonly revision: number;
  /** Event time in integer milliseconds, 0 .. 1_000_000_000_000. */
  readonly eventTimeMs: number;
  /** Integer value in [-1_000_000, 1_000_000]. */
  readonly value: number;
}

/** Aggregates over one fixed 3600s window: (endMs - 3_600_000, endMs]. */
export interface WindowStats {
  readonly count: number;
  /** null when count === 0; otherwise sum / count with no integer rounding. */
  readonly mean: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

export const WINDOW_LENGTH_MS = 3_600_000;
