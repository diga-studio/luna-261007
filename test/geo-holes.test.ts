import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeoIndex, compileDeny, type GeoRow } from "../src/index.ts";
import { collect, formatV4Test, mulberry32, parseCidrTest, parseV4CidrTest, v4ToNum } from "./helpers.ts";

const PLAYGROUND_BASE = v4ToNum("10.0.0.0");
const PLAYGROUND_LEN = 16;
const PLAYGROUND_SIZE = 1 << (32 - PLAYGROUND_LEN);

// Nested: CN top-level, US hole, CN island, JP hole, CN island inside JP hole.
const RECORDS: GeoRow[] = [
  { cidr: "10.0.0.0/16", country: "CN" },
  { cidr: "10.0.128.0/18", country: "US" },
  { cidr: "10.0.160.0/20", country: "CN" },
  { cidr: "10.0.192.0/20", country: "JP" },
  { cidr: "10.0.200.0/24", country: "CN" },
];
const DENY = new Set(["CN"]);
const PROTECTED = ["10.0.160.32/27", "10.0.0.0/24", "10.0.200.128/25"];

async function* rows(): AsyncIterable<GeoRow> {
  yield* RECORDS;
}

/** Independent reference: per-address longest-prefix-match + protection check. */
function referenceDenyMap(): Uint8Array {
  const parsed = RECORDS.map((r) => ({ ...parseV4CidrTest(r.cidr), country: r.country }));
  const prot = PROTECTED.map(parseV4CidrTest);
  const deny = new Uint8Array(PLAYGROUND_SIZE);
  for (let offset = 0; offset < PLAYGROUND_SIZE; offset++) {
    const addr = PLAYGROUND_BASE + offset;
    let bestLen = -1;
    let country: string | null = null;
    for (const p of parsed) {
      const size = 2 ** (32 - p.len);
      if (addr >= p.start && addr < p.start + size && p.len > bestLen) {
        bestLen = p.len;
        country = p.country;
      }
    }
    if (country === null || !DENY.has(country)) continue;
    const protectedHit = prot.some((p) => {
      const size = 2 ** (32 - p.len);
      return addr >= p.start && addr < p.start + size;
    });
    if (!protectedHit) deny[offset] = 1;
  }
  return deny;
}

test("nested country holes plus protected subnets match per-address reference", async () => {
  const index = await buildGeoIndex(rows());
  const output = (await collect(compileDeny(index, DENY, PROTECTED))).map(parseCidrTest);

  // Every output stays inside the playground, sorted, non-overlapping.
  let prevEnd = -1;
  for (const c of output) {
    assert.equal(c.family, 4);
    const start = Number(c.start);
    const size = 2 ** (32 - c.len);
    assert.ok(start >= PLAYGROUND_BASE, "output escapes playground (low)");
    assert.ok(start + size <= PLAYGROUND_BASE + PLAYGROUND_SIZE, "output escapes playground (high)");
    assert.ok(start >= prevEnd, "output not ascending or overlapping");
    prevEnd = start + size;
  }

  // No mergeable sibling pair may remain.
  for (let i = 0; i + 1 < output.length; i++) {
    const a = output[i];
    const b = output[i + 1];
    const size = 2 ** (32 - a.len);
    const mergeable =
      a.len === b.len && Number(a.start) + size === Number(b.start) && Number(a.start) % (2 * size) === 0;
    assert.ok(!mergeable, `mergeable siblings remain: ${a.start}/${a.len} ${b.start}/${b.len}`);
  }

  // Per-address comparison against the reference over the whole playground.
  const expected = referenceDenyMap();
  const covered = new Uint8Array(PLAYGROUND_SIZE);
  for (const c of output) {
    const start = Number(c.start) - PLAYGROUND_BASE;
    const size = 2 ** (32 - c.len);
    covered.fill(1, start, start + size);
  }
  let mismatches = 0;
  for (let i = 0; i < PLAYGROUND_SIZE; i++) {
    if (covered[i] !== expected[i]) mismatches++;
  }
  assert.equal(mismatches, 0, "coverage differs from reference implementation");
  assert.ok(output.length > 0);
});

test("randomized fuzz: output matches per-address reference in a small IPv4 range", async () => {
  const rand = mulberry32(99173);
  const BASE = v4ToNum("10.0.0.0");
  const LEN = 20;
  const SIZE = 1 << (32 - LEN);
  const COUNTRIES = ["CN", "US", "JP", "DE"];

  for (let round = 0; round < 100; round++) {
    const records: GeoRow[] = [];
    const recordCount = 1 + Math.floor(rand() * 30);
    for (let r = 0; r < recordCount; r++) {
      const len = Math.floor(rand() * 33); // /0../32, may escape the playground
      const addr = BASE + Math.floor(rand() * 2 * SIZE) - SIZE;
      records.push({ cidr: `${formatV4Test(addr >>> 0)}/${len}`, country: COUNTRIES[Math.floor(rand() * 4)] });
    }
    const deny = new Set(COUNTRIES.filter(() => rand() < 0.5));
    const protectedCidrs: string[] = [];
    const protCount = Math.floor(rand() * 6);
    for (let p = 0; p < protCount; p++) {
      const len = Math.floor(rand() * 33);
      const addr = BASE + Math.floor(rand() * 2 * SIZE) - SIZE;
      protectedCidrs.push(`${formatV4Test(addr >>> 0)}/${len}`);
    }

    const index = await buildGeoIndex((async function* () {
      yield* records;
    })());
    const output = (await collect(compileDeny(index, deny, protectedCidrs))).map(parseCidrTest);

    // Reference: per-address last-wins LPM + protection.
    const parsed = records.map((r) => ({ ...parseV4CidrTest(r.cidr), country: r.country }));
    const prot = protectedCidrs.map(parseV4CidrTest);
    const refDeny = (addr: number): boolean => {
      let bestLen = -1;
      let country: string | null = null;
      // Later records win ties (same normalized CIDR): scan with >= on length
      // in input order, so the last longest record takes effect.
      for (const p of parsed) {
        const size = 2 ** (32 - p.len);
        if (addr >= p.start && addr < p.start + size && p.len >= bestLen) {
          bestLen = p.len;
          country = p.country;
        }
      }
      if (country === null || !deny.has(country)) return false;
      return !prot.some((p) => {
        const size = 2 ** (32 - p.len);
        return addr >= p.start && addr < p.start + size;
      });
    };
    const expected = new Uint8Array(SIZE);
    for (let offset = 0; offset < SIZE; offset++) {
      if (refDeny(BASE + offset)) expected[offset] = 1;
    }

    const covered = new Uint8Array(SIZE);
    let prevEnd = -1;
    for (const c of output) {
      assert.equal(c.family, 4);
      const start = Number(c.start);
      const size = 2 ** (32 - c.len);
      assert.ok(start >= prevEnd, `round ${round}: output not ascending or overlapping`);
      prevEnd = start + size;
      const lo = Math.max(start, BASE);
      const hi = Math.min(start + size, BASE + SIZE);
      if (lo < hi) covered.fill(1, lo - BASE, hi - BASE);
      // No output address may be allowed; probe boundaries and interior points,
      // including output ranges that extend beyond the playground.
      const probes = new Set<number>([start, start + size - 1]);
      for (let s = 1; s < 4 && s * 7 < size; s++) probes.add(start + s * 7);
      for (const a of probes) {
        assert.ok(refDeny(a), `round ${round}: output covers allowed address ${a}`);
      }
    }
    for (let i = 0; i < SIZE; i++) {
      assert.equal(covered[i], expected[i], `round ${round}: coverage mismatch at offset ${i}`);
    }
    // No mergeable sibling pair may remain.
    for (let i = 0; i + 1 < output.length; i++) {
      const a = output[i];
      const b = output[i + 1];
      const size = 2 ** (32 - a.len);
      const mergeable =
        a.len === b.len && Number(a.start) + size === Number(b.start) && Number(a.start) % (2 * size) === 0;
      assert.ok(!mergeable, `round ${round}: mergeable siblings remain`);
    }
  }
});
