import { parseZone } from "./parser";
import { normalizeRecords } from "./normalize";
import { diffRecords } from "./diff";
import type { ZoneDiff, ZoneRecord } from "./types";

export { ZoneParseError } from "./errors";
export type { RecordType, Rdata, ZoneDiff, ZoneRecord } from "./types";

/** Parse and normalize a zone snapshot into canonical records. */
export function normalizeZone(origin: string, text: string): ZoneRecord[] {
  return normalizeRecords(origin, parseZone(text));
}

/** Diff two zone snapshots; TTL changes appear as remove+add. */
export function diffZones(origin: string, before: string, after: string): ZoneDiff {
  const a = normalizeZone(origin, before);
  const b = normalizeZone(origin, after);
  const { added, removed } = diffRecords(a, b);
  return { added, removed };
}
