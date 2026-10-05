/** Supported record types. */
export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";

/** Canonical RDATA shapes per record type. */
export type Rdata =
  | { readonly kind: "A"; readonly address: string }
  | { readonly kind: "AAAA"; readonly address: string }
  | { readonly kind: "CNAME"; readonly target: string }
  | { readonly kind: "MX"; readonly preference: number; readonly exchange: string }
  | { readonly kind: "TXT"; readonly strings: readonly string[] }
  | { readonly kind: "NS"; readonly target: string };

/** A fully normalized resource record. */
export interface ZoneRecord {
  /** Absolute, lower-cased owner name with trailing dot. */
  readonly owner: string;
  readonly type: RecordType;
  readonly ttl: number;
  readonly rdata: Rdata;
}

/** Result of diffing two snapshots. */
export interface ZoneDiff {
  readonly added: readonly ZoneRecord[];
  readonly removed: readonly ZoneRecord[];
}
