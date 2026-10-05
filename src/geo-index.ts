import { parseCidr } from "./ip.ts";
import type { GeoIndex, GeoRow, PrefixEntry } from "./types.ts";

interface MutableEntry extends PrefixEntry {
  /** Position in the input stream; used to keep the last record of a duplicate. */
  seq: number;
}

function compareEntries(a: MutableEntry, b: MutableEntry): number {
  // Ascending network address; for equal starts, shorter (outer) prefix first;
  // for identical CIDRs, the later record first so dedup keeps the last one.
  if (a.start < b.start) return -1;
  if (a.start > b.start) return 1;
  if (a.len !== b.len) return a.len - b.len;
  return b.seq - a.seq;
}

function sortAndDedup(entries: MutableEntry[]): PrefixEntry[] {
  entries.sort(compareEntries);
  let kept = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (kept > 0 && entries[kept - 1].start === e.start && entries[kept - 1].len === e.len) continue;
    entries[kept++] = e;
  }
  entries.length = kept;
  return entries;
}

/** Consume a one-shot stream of geo records into a reusable read-only index. */
export async function buildGeoIndex(rows: AsyncIterable<GeoRow>): Promise<GeoIndex> {
  const v4: MutableEntry[] = [];
  const v6: MutableEntry[] = [];
  let seq = 0;
  for await (const row of rows) {
    const { family, start, len } = parseCidr(row.cidr);
    const entry: MutableEntry = { start, len, country: row.country, seq: seq++ };
    if (family === 4) v4.push(entry);
    else v6.push(entry);
  }
  return Object.freeze({
    v4: Object.freeze(sortAndDedup(v4)),
    v6: Object.freeze(sortAndDedup(v6)),
  });
}
