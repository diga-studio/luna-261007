import { lexZone } from "./lexer.ts";
import { parseZone } from "./parser.ts";
import { parseRdata } from "./rdata.ts";
import type { Rdata, ZoneRecord } from "./types.ts";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Canonical string for an RDATA, used for dedup, equality and ordering. */
export function rdataKey(rdata: Rdata): string {
  switch (rdata.kind) {
    case "A":
      return rdata.octets.join(".");
    case "AAAA":
      return hex(rdata.bytes);
    case "CNAME":
    case "NS":
      return rdata.target;
    case "MX":
      return `${rdata.preference} ${rdata.exchange}`;
    case "TXT":
      // Length-prefixed chunks keep chunk boundaries significant.
      return rdata.chunks
        .map((chunk) => `${chunk.length}:${hex(chunk)}`)
        .join(",");
  }
}

/** Canonical key for a whole record; identical semantics give identical keys. */
export function recordKey(record: ZoneRecord): string {
  return [
    record.owner,
    record.type,
    String(record.ttl),
    rdataKey(record.rdata),
  ].join("\t");
}

/**
 * Normalize a zone master file: parse, canonicalize, deduplicate and
 * return records in a deterministic order.
 */
export function normalizeZone(origin: string, text: string): ZoneRecord[] {
  const entries = lexZone(text);
  const rawRecords = parseZone(origin, entries);
  const byKey = new Map<string, ZoneRecord>();
  for (const raw of rawRecords) {
    const record: ZoneRecord = {
      owner: raw.owner,
      type: raw.type,
      ttl: raw.ttl,
      rdata: parseRdata(raw.type, raw.rdata, raw.origin),
    };
    const key = recordKey(record);
    if (!byKey.has(key)) {
      byKey.set(key, record);
    }
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, record]) => record);
}
