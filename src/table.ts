/**
 * Sorted record table: the memory-frugal index structure behind GeoIndex.
 *
 * Records live in parallel typed arrays (~25 bytes/record, off the V8
 * heap), sorted by (network, prefixLen) ascending. The sort is stable, so
 * within a run of identical normalized CIDRs the input order is preserved
 * and dedup keeps the last record, giving "last write wins" semantics.
 */

export interface RecordTable {
  readonly maxBits: number;
  /** Number of records after dedup. */
  readonly count: number;
  /** Network address high 64 bits. */
  readonly hi: BigUint64Array;
  /** Network address low 64 bits. */
  readonly lo: BigUint64Array;
  readonly len: Uint8Array;
  readonly country: Int32Array;
}

const MASK64 = 0xffffffffffffffffn;

/** First index in [from, to) whose network is >= (netHi, netLo). */
export function lowerBound(
  table: RecordTable,
  from: number,
  to: number,
  netHi: bigint,
  netLo: bigint,
): number {
  const { hi, lo } = table;
  let lo_ = from;
  let hi_ = to;
  while (lo_ < hi_) {
    const mid = (lo_ + hi_) >>> 1;
    const h = hi[mid];
    if (h < netHi || (h === netHi && lo[mid] < netLo)) lo_ = mid + 1;
    else hi_ = mid;
  }
  return lo_;
}

export class TableBuilder {
  private hi: BigUint64Array;
  private lo: BigUint64Array;
  private len: Uint8Array;
  private country: Int32Array;
  private count = 0;

  constructor(private readonly maxBits: number) {
    this.hi = new BigUint64Array(1024);
    this.lo = new BigUint64Array(1024);
    this.len = new Uint8Array(1024);
    this.country = new Int32Array(1024);
  }

  add(network: bigint, prefixLen: number, countryId: number): void {
    if (this.count === this.hi.length) {
      const cap = this.hi.length * 2;
      const hi = new BigUint64Array(cap);
      const lo = new BigUint64Array(cap);
      const len = new Uint8Array(cap);
      const country = new Int32Array(cap);
      hi.set(this.hi);
      lo.set(this.lo);
      len.set(this.len);
      country.set(this.country);
      this.hi = hi;
      this.lo = lo;
      this.len = len;
      this.country = country;
    }
    this.hi[this.count] = network >> 64n;
    this.lo[this.count] = network & MASK64;
    this.len[this.count] = prefixLen;
    this.country[this.count] = countryId;
    this.count++;
  }

  /** Sort by (network, prefixLen) and drop all but the last of each duplicate run. */
  finish(): RecordTable {
    const { hi, lo, len, country, count } = this;
    const order: number[] = Array.from({ length: count }, (_, i) => i);
    order.sort((a, b) => {
      const ha = hi[a];
      const hb = hi[b];
      if (ha !== hb) return ha < hb ? -1 : 1;
      const la = lo[a];
      const lb = lo[b];
      if (la !== lb) return la < lb ? -1 : 1;
      return len[a] - len[b];
    });

    const outHi = new BigUint64Array(count);
    const outLo = new BigUint64Array(count);
    const outLen = new Uint8Array(count);
    const outCountry = new Int32Array(count);
    let out = 0;
    for (let i = 0; i < count; i++) {
      // Skip records that a later record with the same (network, len) overrides.
      if (
        i + 1 < count &&
        hi[order[i + 1]] === hi[order[i]] &&
        lo[order[i + 1]] === lo[order[i]] &&
        len[order[i + 1]] === len[order[i]]
      ) {
        continue;
      }
      const src = order[i];
      outHi[out] = hi[src];
      outLo[out] = lo[src];
      outLen[out] = len[src];
      outCountry[out] = country[src];
      out++;
    }
    // Release builder buffers so they do not linger in the built index.
    this.hi = new BigUint64Array(0);
    this.lo = new BigUint64Array(0);
    this.len = new Uint8Array(0);
    this.country = new Int32Array(0);
    this.count = 0;
    return {
      maxBits: this.maxBits,
      count: out,
      hi: outHi.subarray(0, out),
      lo: outLo.subarray(0, out),
      len: outLen.subarray(0, out),
      country: outCountry.subarray(0, out),
    };
  }
}
