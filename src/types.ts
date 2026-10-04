/** Severity level of an observation, highest first. */
export type Severity = 'critical' | 'standard' | 'informational';

/** Numeric rank used for max-severity aggregation (higher = more severe). */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 2,
  standard: 1,
  informational: 0,
};

export const RANK_SEVERITY: readonly Severity[] = ['informational', 'standard', 'critical'];

/** One ownership interval of an IP: [startMs, endMs), endMs null = open-ended. */
export interface OwnershipInterval {
  startMs: number;
  endMs: number | null;
  assetId: string;
}

/** A single connection observation supplied by the caller. */
export interface Observation {
  id: string;
  srcIp: string;
  dstIp: string;
  observedAtMs: number;
  severity: Severity;
}

/** Aggregated directed dependency between two assets. */
export interface Dependency {
  srcAsset: string;
  dstAsset: string;
  supportCount: number;
  lastObservedAtMs: number;
  severity: Severity;
  stale: boolean;
}

/** Result of a batch ingest call. */
export interface IngestResult {
  received: number;
  accepted: number;
  duplicates: number;
}

/** 72 hours in milliseconds: staleness threshold. */
export const STALE_THRESHOLD_MS = 72 * 60 * 60 * 1000;
