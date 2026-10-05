/** A single parsed geo-attribution record. */
export interface GeoRow {
  cidr: string;
  country: string;
}

export type Family = 4 | 6;

/** Internal per-prefix entry stored in the index. */
export interface PrefixEntry {
  /** Normalized network address (host bits cleared). */
  start: bigint;
  /** Prefix length. */
  len: number;
  country: string;
}

/** Read-only, reusable geo index returned by buildGeoIndex. */
export interface GeoIndex {
  readonly v4: readonly PrefixEntry[];
  readonly v6: readonly PrefixEntry[];
}
