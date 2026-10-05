import { recordKey } from "./normalize";
import type { ZoneRecord } from "./types";

/** Set-based diff of two normalized record lists; multiplicity is ignored. */
export function diffRecords(
  before: readonly ZoneRecord[],
  after: readonly ZoneRecord[],
): { added: ZoneRecord[]; removed: ZoneRecord[] } {
  const beforeKeys = new Set(before.map(recordKey));
  const afterKeys = new Set(after.map(recordKey));
  return {
    added: after.filter((record) => !beforeKeys.has(recordKey(record))),
    removed: before.filter((record) => !afterKeys.has(recordKey(record))),
  };
}
