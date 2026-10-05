/** A single (environment, resourceType, action) tuple. */
export interface Triple {
  readonly environment: string;
  readonly resourceType: string;
  readonly action: string;
}

/** A grant: uniquely numbered, covers a set of triples. Kept or revoked as a whole. */
export interface Grant {
  readonly id: number;
  readonly coverage: readonly Triple[];
}

/** A single access log entry. */
export interface AccessEvent {
  readonly triple: Triple;
  /** Epoch milliseconds of the access. */
  readonly timestamp: number;
  readonly success: boolean;
}

/** Analysis snapshot for one user. Immutable during analysis. */
export interface Snapshot {
  /** Caller-provided reference time T, epoch milliseconds. */
  readonly now: number;
  readonly grants: readonly Grant[];
  readonly accesses: readonly AccessEvent[];
}

/** Recommendation output: which grants to keep and which to revoke. */
export interface Recommendation {
  /** Grant ids to keep, ascending. */
  readonly keep: readonly number[];
  /** Grant ids to revoke, ascending. */
  readonly revoke: readonly number[];
}
