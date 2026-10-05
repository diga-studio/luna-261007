/** Supported record types. */
export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";

/** Normalized RDATA payload, compared field by field. */
export type Rdata =
  | { kind: "A"; octets: [number, number, number, number] }
  | { kind: "AAAA"; bytes: Uint8Array } // always 16 bytes
  | { kind: "CNAME"; target: string } // absolute, lowercased, trailing dot
  | { kind: "NS"; target: string }
  | { kind: "MX"; preference: number; exchange: string }
  | { kind: "TXT"; chunks: Uint8Array[] }; // ordered byte chunks, case sensitive

/** A normalized zone record. Owner is absolute, lowercased, with trailing dot. */
export interface ZoneRecord {
  owner: string;
  type: RecordType;
  ttl: number;
  rdata: Rdata;
}

/** Result of diffZones: sets of normalized records. */
export interface ZoneDiff {
  added: ZoneRecord[];
  removed: ZoneRecord[];
}

/** Error thrown for any parse/normalization failure. */
export class ZoneParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoneParseError";
  }
}
