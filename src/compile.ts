import { familyBits, parseCidr, rangeToCidrs } from "./ip.ts";
import type { Family, GeoIndex } from "./types.ts";

interface Interval {
  start: bigint;
  /** Exclusive end. */
  end: bigint;
  /** null marks a protected (always-allow) interval. */
  country: string | null;
}

function compareIntervals(a: Interval, b: Interval): number {
  if (a.start < b.start) return -1;
  if (a.start > b.start) return 1;
  // Equal start: the shorter prefix contains the longer one, so it sorts first.
  return a.end > b.end ? -1 : a.end < b.end ? 1 : 0;
}

function toIntervals(
  index: GeoIndex,
  family: Family,
  protectedByFamily: { 4: Interval[]; 6: Interval[] },
): Interval[] {
  const bits = familyBits(family);
  const entries = family === 4 ? index.v4 : index.v6;
  const geo: Interval[] = new Array(entries.length);
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    geo[k] = { start: e.start, end: e.start + (1n << BigInt(bits - e.len)), country: e.country };
  }
  const prot = protectedByFamily[family];
  if (prot.length === 0) return geo;
  // Both lists are sorted by (start, len); merge in O(n).
  const merged: Interval[] = new Array(geo.length + prot.length);
  let a = 0;
  let b = 0;
  let m = 0;
  while (a < geo.length && b < prot.length) {
    merged[m++] = compareIntervals(geo[a], prot[b]) <= 0 ? geo[a++] : prot[b++];
  }
  while (a < geo.length) merged[m++] = geo[a++];
  while (b < prot.length) merged[m++] = prot[b++];
  return merged;
}

function* sweepFamily(
  family: Family,
  intervals: Interval[],
  deny: ReadonlySet<string>,
): Generator<string> {
  const stack: Interval[] = [];
  let protectedCount = 0;
  let i = 0;
  let cur = 0n;
  let runStart: bigint | null = null;
  const n = intervals.length;
  while (i < n || stack.length > 0) {
    if (stack.length === 0) {
      // The gap between the previous interval and the next one is allowed:
      // close any open deny run before jumping forward.
      if (runStart !== null) {
        yield* rangeToCidrs(family, runStart, cur);
        runStart = null;
      }
      cur = intervals[i].start;
    }
    while (i < n && intervals[i].start <= cur) {
      const iv = intervals[i++];
      stack.push(iv);
      if (iv.country === null) protectedCount++;
    }
    const topEnd = stack[stack.length - 1].end;
    const nextStart = i < n ? intervals[i].start : null;
    const ev = nextStart !== null && nextStart < topEnd ? nextStart : topEnd;
    if (ev > cur) {
      const top = stack[stack.length - 1];
      const denied =
        protectedCount === 0 && top.country !== null && deny.has(top.country);
      if (denied) {
        if (runStart === null) runStart = cur;
      } else if (runStart !== null) {
        yield* rangeToCidrs(family, runStart, cur);
        runStart = null;
      }
    }
    cur = ev;
    while (stack.length > 0 && stack[stack.length - 1].end <= cur) {
      const iv = stack.pop()!;
      if (iv.country === null) protectedCount--;
    }
  }
  if (runStart !== null) yield* rangeToCidrs(family, runStart, cur);
}

/**
 * Compile the exact, minimal deny CIDR set for the given countries,
 * with protected CIDRs always taking precedence (allowed).
 * IPv4 ranges are emitted first, then IPv6, each in ascending order.
 */
export function compileDeny(
  index: GeoIndex,
  countries: ReadonlySet<string> | readonly string[],
  protectedCidrs: readonly string[],
): AsyncIterable<string> {
  const deny: ReadonlySet<string> =
    countries instanceof Set ? countries : new Set(countries);
  const protectedByFamily: { 4: Interval[]; 6: Interval[] } = { 4: [], 6: [] };
  for (const cidr of protectedCidrs) {
    const { family, start, len } = parseCidr(cidr);
    const bits = familyBits(family);
    protectedByFamily[family].push({
      start,
      end: start + (1n << BigInt(bits - len)),
      country: null,
    });
  }
  protectedByFamily[4].sort(compareIntervals);
  protectedByFamily[6].sort(compareIntervals);

  const gen = function* (): Generator<string> {
    yield* sweepFamily(4, toIntervals(index, 4, protectedByFamily), deny);
    yield* sweepFamily(6, toIntervals(index, 6, protectedByFamily), deny);
  };

  return {
    [Symbol.asyncIterator]() {
      const it = gen();
      return {
        next: () => Promise.resolve(it.next()),
      };
    },
  };
}
