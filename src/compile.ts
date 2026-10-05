import { lowerBound, type RecordTable } from "./table.js";

const MASK64 = 0xffffffffffffffffn;

/**
 * Compile the exact minimal deny CIDR set for one address family by
 * divide-and-conquer over the address space.
 *
 * The record table is sorted by network, so the records inside any address
 * range form a contiguous slice; each recursion node re-splits its slice
 * with binary searches instead of scanning. A node reports whether its
 * whole subtree is uniformly denied ("full"); a full child emits nothing
 * and lets the parent merge the two halves, so sibling merges cascade as
 * far as possible. A pending one-slot buffer keeps the emitted stream in
 * ascending network-address order. Ranges holding a single record are
 * resolved directly without descending bit by bit.
 */
export function* compileFamily(
  records: RecordTable,
  protectedTable: RecordTable,
  isDenied: (countryId: number) => boolean,
  maxBits: number,
): Generator<{ network: bigint; prefixLen: number }> {
  const recLen = records.len;
  const recCountry = records.country;
  const protLen = protectedTable.len;

  const networkAt = (table: RecordTable, i: number): bigint =>
    (table.hi[i] << 64n) | table.lo[i];

  function* walk(
    lo: number,
    hi: number,
    pLo: number,
    pHi: number,
    prefix: bigint,
    depth: number,
    country: number,
    protAbove: boolean,
  ): Generator<{ network: bigint; prefixLen: number }, boolean> {
    if (protAbove) return false;

    // Records whose network equals this node's prefix form a run at the
    // start of the slice, sorted by prefix length.
    const nextNet = prefix + 1n;
    const runEnd = lowerBound(records, lo, hi, nextNet >> 64n, nextNet & MASK64);
    // The run is sorted by length; scanning from the top finds the longest
    // record covering this node (deeper records at the same network are
    // skipped, shorter ones still apply).
    for (let i = runEnd - 1; i >= lo; i--) {
      if (recLen[i] <= depth) {
        country = recCountry[i];
        break;
      }
    }

    const protRunEnd = lowerBound(protectedTable, pLo, pHi, nextNet >> 64n, nextNet & MASK64);
    const protHere =
      protAbove || (protRunEnd > pLo && protLen[pLo] <= depth);
    if (protHere) return false;

    const denied = country >= 0 && isDenied(country);

    const recInterior = runEnd < hi || (runEnd > lo && recLen[runEnd - 1] > depth);
    const protInterior =
      protRunEnd < pHi || (protRunEnd > pLo && protLen[protRunEnd - 1] > depth);
    if (!recInterior && !protInterior) return denied; // uniform subtree

    // Fast path: a single record below this node and no protected entries.
    if (hi - lo === 1 && pLo >= pHi) {
      const q = networkAt(records, lo);
      const l = recLen[lo];
      const c = recCountry[lo];
      const recordDenied = isDenied(c);
      if (recordDenied === denied) return denied;
      if (!denied) {
        // Allowed space with one denied prefix inside.
        yield { network: q, prefixLen: l };
        return false;
      }
      // Denied space with one allowed prefix inside: emit the sibling
      // CIDRs along the record's path, ascending.
      const above: Array<{ network: bigint; prefixLen: number }> = [];
      for (let j = depth; j < l; j++) {
        const shift = BigInt(maxBits - 1 - j);
        const bit = (q >> shift) & 1n;
        const sibling = (q & ~((2n << shift) - 1n)) | ((1n - bit) << shift);
        if (bit === 1n) yield { network: sibling, prefixLen: j + 1 };
        else above.push({ network: sibling, prefixLen: j + 1 });
      }
      for (let i = above.length - 1; i >= 0; i--) yield above[i];
      return false;
    }

    const shift = BigInt(maxBits - 1 - depth);
    const midAddr = prefix | (1n << shift);
    const midHi = midAddr >> 64n;
    const midLo = midAddr & MASK64;
    const recMid = lowerBound(records, lo, hi, midHi, midLo);
    const protMid = lowerBound(protectedTable, pLo, pHi, midHi, midLo);
    const rightPrefix = midAddr;

    const leftFull =
      recMid > lo || protMid > pLo
        ? yield* walk(lo, recMid, pLo, protMid, prefix, depth + 1, country, protHere)
        : denied;
    let pending: { network: bigint; prefixLen: number } | null = leftFull
      ? { network: prefix, prefixLen: depth + 1 }
      : null;

    let rightFull: boolean;
    if (recMid < hi || protMid < pHi) {
      const gen = walk(recMid, hi, protMid, pHi, rightPrefix, depth + 1, country, protHere);
      let step = gen.next();
      while (!step.done) {
        if (pending !== null) {
          yield pending;
          pending = null;
        }
        yield step.value;
        step = gen.next();
      }
      rightFull = step.value;
    } else {
      rightFull = denied;
    }
    // A full right subtree emits nothing, so `pending` survives untouched
    // whenever both halves merge.
    if (leftFull && rightFull) return true;
    if (pending !== null) yield pending;
    if (rightFull) yield { network: rightPrefix, prefixLen: depth + 1 };
    return false;
  }

  if (records.count === 0 && protectedTable.count === 0) return;
  const rootFull = yield* walk(0, records.count, 0, protectedTable.count, 0n, 0, -1, false);
  if (rootFull) yield { network: 0n, prefixLen: 0 };
}
