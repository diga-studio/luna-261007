/** Severity level of an observation / dependency, ordered low -> high. */
export type Severity = 'informational' | 'standard' | 'critical';

export const SEVERITY_RANK: Record<Severity, number> = {
  informational: 1,
  standard: 2,
  critical: 3,
};

/** One ownership interval of an IP. [startMs, endMs), UTC milliseconds. */
export interface OwnershipInterval {
  /** Inclusive start, UTC ms. */
  readonly startMs: number;
  /** Exclusive end, UTC ms. */
  readonly endMs: number;
  /** Asset that owns the IP during the interval. */
  readonly assetId: string;
}

/** A single connection observation delivered by the caller. */
export interface Observation {
  /** Stable ID; duplicates with the same ID arrive with identical content. */
  readonly id: string;
  readonly srcIp: string;
  readonly dstIp: string;
  /** Observation time, UTC ms. */
  readonly observedAtMs: number;
  readonly severity: Severity;
}

/** A directed dependency edge between two assets. */
export interface Dependency {
  readonly srcAssetId: string;
  readonly dstAssetId: string;
  /** Number of supporting observations. */
  readonly supportCount: number;
  /** Max observedAtMs across supporting observations. */
  readonly lastObservedAtMs: number;
  /** Highest severity across supporting observations. */
  readonly severity: Severity;
  /** True when (readNowMs - lastObservedAtMs) >= 72h. */
  readonly stale: boolean;
}

/** Result summary of a batch observation ingest. */
export interface IngestResult {
  /** Observations that were new (not duplicates). */
  readonly inserted: number;
  /** Observations ignored because their ID was already stored. */
  readonly duplicates: number;
}

/** Result summary of an ownership timeline revision. */
export interface RevisionResult {
  /** Observations whose resolved attribution changed. */
  readonly reattributed: number;
  /** Dependency edges that were touched (created, updated, or removed). */
  readonly affectedEdges: number;
}

export const STALE_THRESHOLD_MS = 72 * 60 * 60 * 1000;
