import { normalizeZone, recordKey } from "./normalize.ts";
import type { ZoneDiff, ZoneRecord } from "./types.ts";

/**
 * Diff two zone snapshots. TTL changes appear as remove+add.
 * Duplicate records in input do not affect the result.
 */
export function diffZones(
  origin: string,
  before: string,
  after: string,
): ZoneDiff {
  const beforeRecords = normalizeZone(origin, before);
  const afterRecords = normalizeZone(origin, after);
  const beforeKeys = new Set(beforeRecords.map(recordKey));
  const afterKeys = new Set(afterRecords.map(recordKey));
  const added: ZoneRecord[] = afterRecords.filter(
    (record) => !beforeKeys.has(recordKey(record)),
  );
  const removed: ZoneRecord[] = beforeRecords.filter(
    (record) => !afterKeys.has(recordKey(record)),
  );
  return { added, removed };
}
