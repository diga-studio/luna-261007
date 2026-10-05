import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeoIndex, compileDeny, type GeoIndex, type GeoRow } from "../src/index.ts";
import {
  formatV4Test,
  formatV6Test,
  mulberry32,
  parseCidrTest,
  cidrEndExclusive,
} from "./helpers.ts";

const MIB = 1024 * 1024;
const RSS_LIMIT = 512 * MIB;
const TOTAL = 500_000;
const V6_COUNT = 250_000;
const PROTECTED_COUNT = 200;
const COUNTRIES = ["C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7"];
const DENY = new Set(["C1", "C3", "C5"]);

function peakRssBytes(): number {
  // ru_maxrss is bytes on macOS, kilobytes on Linux.
  const max = process.resourceUsage().maxRSS;
  return process.platform === "darwin" ? max : max * 1024;
}

function msSince(t0: bigint): number {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/** splitmix64: deterministic per-record pseudo-random bits. */
function hash64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  return z ^ (z >> 31n);
}

/** Multiplicative permutation of 0..TOTAL-1 (217661 is coprime to 500000). */
function permute(k: number): number {
  return Number((BigInt(k) * 217661n) % BigInt(TOTAL));
}

interface RecordShape {
  family: 4 | 6;
  /** Normalized network address (host bits already cleared). */
  start: bigint;
  len: number;
  country: string;
  cidr: string;
}

/**
 * Deterministic content for record i. The first V6_COUNT records are distinct
 * IPv6 /64 prefixes (random host bits set in the CIDR string); the rest are
 * IPv4 records with random lengths (host bits usually set).
 */
function recordAt(i: number): RecordShape {
  const h = hash64(BigInt(i));
  const country = COUNTRIES[Number(h % 8n)];
  if (i < V6_COUNT) {
    const network = (0x2001n << 112n) | (BigInt(i) << 64n);
    const host = hash64(BigInt(i) ^ 0xdeadbeefn);
    return { family: 6, start: network, len: 64, country, cidr: `${formatV6Test(network | host)}/64` };
  }
  const addr = Number(h & 0xffffffffn);
  const len = 8 + Number((h >> 40n) % 25n);
  const start = BigInt(addr) & ~((1n << BigInt(32 - len)) - 1n);
  return { family: 4, start, len, country, cidr: `${formatV4Test(addr)}/${len}` };
}

/** One-shot shuffled record stream; O(1) memory. */
async function* rowStream(): AsyncIterable<GeoRow> {
  for (let k = 0; k < TOTAL; k++) {
    const rec = recordAt(permute(k));
    yield { cidr: rec.cidr, country: rec.country };
  }
}

interface Sample {
  family: 4 | 6;
  addr: bigint;
  expected: boolean;
}

test("500k shuffled records: full compile within RSS limit, streaming output verified", async () => {
  // Phase A: build the index from a one-shot async iterable.
  const tBuild = process.hrtime.bigint();
  const index: GeoIndex = await buildGeoIndex(rowStream());
  gc();
  const buildMs = msSince(tBuild);

  // Phase B: independent reference model (normalized map, last record wins)
  // plus per-sample expectations; released before compiling.
  const tRef = process.hrtime.bigint();
  const refMap = new Map<string, string>();
  let distinctV6 = 0;
  for (let k = 0; k < TOTAL; k++) {
    const rec = recordAt(permute(k));
    const key = `${rec.family}:${rec.len}:${rec.start.toString(16)}`;
    if (rec.family === 6 && !refMap.has(key)) distinctV6++;
    refMap.set(key, rec.country);
  }
  assert.ok(distinctV6 >= V6_COUNT, `need >= ${V6_COUNT} distinct IPv6 prefixes, got ${distinctV6}`);

  const rand = mulberry32(777);
  const randBelow = (n: number) => Math.floor(rand() * n);
  const protectedCidrs: string[] = [];
  const protectedIntervals: { family: 4 | 6; start: bigint; end: bigint }[] = [];
  for (let k = 0; k < PROTECTED_COUNT; k++) {
    let cidr: string;
    if (k % 2 === 0) {
      cidr = `${formatV4Test(randBelow(0x100000000) >>> 0)}/${8 + randBelow(25)}`;
    } else {
      let v6 = 0n;
      for (let got = 0; got < 96; got += 32) v6 = (v6 << 32n) | BigInt((rand() * 0x100000000) >>> 0);
      cidr = `${formatV6Test((0x2001n << 112n) | v6)}/${48 + randBelow(81)}`;
    }
    const p = parseCidrTest(cidr);
    protectedCidrs.push(cidr);
    protectedIntervals.push({ family: p.family, start: p.start, end: cidrEndExclusive(p.start, p.family, p.len) });
  }
  const isProtected = (family: 4 | 6, addr: bigint): boolean =>
    protectedIntervals.some((iv) => iv.family === family && addr >= iv.start && addr < iv.end);
  const refLookup = (family: 4 | 6, addr: bigint): string | null => {
    const bits = family === 4 ? 32 : 128;
    for (let len = bits; len >= 0; len--) {
      const shift = BigInt(bits - len);
      const hit = refMap.get(`${family}:${len}:${((addr >> shift) << shift).toString(16)}`);
      if (hit !== undefined) return hit;
    }
    return null;
  };

  const samples: Sample[] = [];
  const pushSample = (family: 4 | 6, addr: bigint) => {
    const country = refLookup(family, addr);
    samples.push({ family, addr, expected: country !== null && DENY.has(country) && !isProtected(family, addr) });
  };
  const randBits = (bits: number): bigint => {
    let v = 0n;
    for (let got = 0; got < bits; got += 32) v = (v << 32n) | BigInt((rand() * 0x100000000) >>> 0);
    return v & ((1n << BigInt(bits)) - 1n);
  };
  for (let s = 0; s < 3000; s++) {
    const rec = recordAt(randBelow(TOTAL));
    const bits = rec.family === 4 ? 32 : 128;
    pushSample(rec.family, rec.start | randBits(bits - rec.len));
  }
  for (let s = 0; s < 1000; s++) pushSample(4, randBits(32));
  for (let s = 0; s < 1000; s++) pushSample(6, randBits(128));
  const samples4 = samples.filter((s) => s.family === 4).sort((a, b) => (a.addr < b.addr ? -1 : 1));
  const samples6 = samples.filter((s) => s.family === 6).sort((a, b) => (a.addr < b.addr ? -1 : 1));
  refMap.clear();
  gc();
  const refMs = msSince(tRef);

  // Phase C: compile and fully consume with streaming checks.
  const tCompile = process.hrtime.bigint();
  let count = 0;
  let hash = 0;
  let prevFamily = 4;
  let prevEnd = 0n;
  let ptr4 = 0;
  let ptr6 = 0;
  for await (const cidr of compileDeny(index, DENY, protectedCidrs)) {
    const p = parseCidrTest(cidr);
    const end = cidrEndExclusive(p.start, p.family, p.len);
    assert.ok(p.family >= prevFamily, "IPv4 output must precede IPv6 output");
    if (p.family !== prevFamily) {
      prevFamily = p.family;
      prevEnd = 0n;
    }
    assert.ok(p.start >= prevEnd, "output not ascending or overlapping within a family");
    prevEnd = end;
    const samplesForFamily = p.family === 4 ? samples4 : samples6;
    let ptr = p.family === 4 ? ptr4 : ptr6;
    while (ptr < samplesForFamily.length && samplesForFamily[ptr].addr < p.start) {
      assert.equal(samplesForFamily[ptr].expected, false, "sample uncovered by output but expected deny");
      ptr++;
    }
    while (ptr < samplesForFamily.length && samplesForFamily[ptr].addr < end) {
      assert.equal(samplesForFamily[ptr].expected, true, "sample covered by output but expected allow");
      ptr++;
    }
    if (p.family === 4) ptr4 = ptr;
    else ptr6 = ptr;
    for (let ci = 0; ci < cidr.length; ci++) hash = (hash * 31 + cidr.charCodeAt(ci)) | 0;
    count++;
  }
  for (const s of samples4.slice(ptr4)) assert.equal(s.expected, false, "tail sample uncovered but expected deny");
  for (const s of samples6.slice(ptr6)) assert.equal(s.expected, false, "tail sample uncovered but expected deny");
  const compileMs = msSince(tCompile);

  const peak = Math.max(peakRssBytes(), process.memoryUsage().rss);
  console.log(
    `[scale] records=${TOTAL} distinctV6=${distinctV6} outputCidrs=${count} hash=${hash} ` +
      `build=${buildMs.toFixed(0)}ms reference=${refMs.toFixed(0)}ms compile+consume=${compileMs.toFixed(0)}ms ` +
      `peakRSS=${(peak / MIB).toFixed(1)}MiB`,
  );
  assert.ok(count > 0, "scale compile produced no output");
  assert.ok(peak < RSS_LIMIT, `peak RSS ${(peak / MIB).toFixed(1)}MiB exceeds 512MiB`);
});
