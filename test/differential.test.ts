import { describe, expect, it } from "vitest";
import { buildGeoIndex, compileDeny, type GeoRow } from "../dist/index.js";
import { Family, MAX_BITS, maskNetwork, parseCidr } from "../dist/ip.js";

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Ref {
  rows: GeoRow[];
  deny: ReadonlySet<string>;
  protectedCidrs: string[];
}

function referenceIsDenied(
  { rows, deny, protectedCidrs }: Ref,
  family: Family,
  addr: bigint,
): boolean {
  const maxBits = MAX_BITS[family];
  for (const text of protectedCidrs) {
    const p = parseCidr(text);
    if (p.family === family && maskNetwork(addr, p.prefixLen, maxBits) === p.network) {
      return false;
    }
  }
  let bestLen = -1;
  let bestCountry: string | undefined;
  for (const row of rows) {
    const p = parseCidr(row.cidr);
    if (p.family !== family) continue;
    if (p.prefixLen >= bestLen && maskNetwork(addr, p.prefixLen, maxBits) === p.network) {
      bestLen = p.prefixLen;
      bestCountry = row.country;
    }
  }
  return bestCountry !== undefined && deny.has(bestCountry);
}

function coversAny(outputs: string[], family: Family, addr: bigint): boolean {
  const maxBits = MAX_BITS[family];
  for (const text of outputs) {
    const p = parseCidr(text);
    if (p.family !== family) continue;
    if (maskNetwork(addr, p.prefixLen, maxBits) === p.network) return true;
  }
  return false;
}

async function* streamRows(rows: GeoRow[]): AsyncIterable<GeoRow> {
  for (const row of rows) yield row;
}

describe("randomized differential vs brute-force reference", () => {
  it("matches on every address of small random IPv4 spaces", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = mulberry32(seed);
      const pick = (n: number) => Math.floor(rand() * n);
      const countries = ["A", "B", "C", "D"];
      const rows: GeoRow[] = [];
      const recordCount = 5 + pick(30);
      for (let i = 0; i < recordCount; i++) {
        const addr = (10 << 24) | (pick(2) << 20) | pick(0x100000);
        const prefixLen = 16 + pick(17); // /16../32 around two dense /20 blocks
        rows.push({ cidr: `${(addr >>> 24) & 255}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}/${prefixLen}`, country: countries[pick(4)] });
      }
      const protectedCidrs: string[] = [];
      for (let i = 0; i < pick(4); i++) {
        const addr = (10 << 24) | (pick(2) << 20) | pick(0x100000);
        protectedCidrs.push(`${(addr >>> 24) & 255}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}/${16 + pick(17)}`);
      }
      const deny = new Set(countries.filter(() => rand() < 0.5));
      const index = await buildGeoIndex(streamRows(rows));
      const outputs = await Array.fromAsync(compileDeny(index, deny, protectedCidrs));
      const ref: Ref = { rows, deny, protectedCidrs };
      // Check every address in the two /20 neighborhoods.
      for (let block = 0; block < 2; block++) {
        const base = BigInt((10 << 24) | (block << 20));
        for (let i = 0n; i < 0x1000n; i += 1n) {
          const addr = base + i;
          const expected = referenceIsDenied(ref, Family.V4, addr);
          const actual = coversAny(outputs, Family.V4, addr);
          if (expected !== actual) {
            throw new Error(
              `seed=${seed} addr=${addr.toString(16)} expected=${expected} outputs=${outputs.join(",")}`,
            );
          }
        }
      }
    }
  }, 120_000);

  it("matches on sampled addresses of random IPv6 spaces", async () => {
    for (let seed = 100; seed < 120; seed++) {
      const rand = mulberry32(seed);
      const pick = (n: number) => Math.floor(rand() * n);
      const randBits32 = () => Math.floor(rand() * 0x100000000);
      const countries = ["A", "B", "C", "D"];
      // Confine records to a random /64 window so sampled probes are dense.
      const windowHi = (BigInt(randBits32()) << 32n) | BigInt(randBits32());
      const rows: GeoRow[] = [];
      const recordCount = 5 + pick(30);
      for (let i = 0; i < recordCount; i++) {
        const lo = (BigInt(randBits32()) << 32n) | BigInt(randBits32());
        const prefixLen = 64 + pick(65); // /64../128
        const network = (windowHi << 64n) | maskNetwork(lo, prefixLen - 64, 64);
        rows.push({ cidr: `${formatForTest(network)}/${prefixLen}`, country: countries[pick(4)] });
      }
      const protectedCidrs: string[] = [];
      for (let i = 0; i < pick(4); i++) {
        const lo = (BigInt(randBits32()) << 32n) | BigInt(randBits32());
        const prefixLen = 64 + pick(65);
        protectedCidrs.push(`${formatForTest((windowHi << 64n) | lo)}/${prefixLen}`);
      }
      const deny = new Set(countries.filter(() => rand() < 0.5));
      const index = await buildGeoIndex(streamRows(rows));
      const outputs = await Array.fromAsync(compileDeny(index, deny, protectedCidrs));
      const ref: Ref = { rows, deny, protectedCidrs };
      const probes = new Set<bigint>();
      for (let i = 0; i < 2000; i++) {
        probes.add(
          (windowHi << 64n) | (BigInt(randBits32()) << 32n) | BigInt(randBits32()),
        );
      }
      // Always probe record and protected network edges.
      for (const text of [...rows.map((r) => r.cidr), ...protectedCidrs]) {
        const p = parseCidr(text);
        probes.add(p.network);
        probes.add(p.network - 1n);
        probes.add(p.network + (1n << BigInt(128 - p.prefixLen)) - 1n);
        probes.add(p.network + (1n << BigInt(128 - p.prefixLen)));
      }
      for (const addr of probes) {
        if (addr < 0n || addr >= 1n << 128n) continue;
        const expected = referenceIsDenied(ref, Family.V6, addr);
        const actual = coversAny(outputs, Family.V6, addr);
        if (expected !== actual) {
          throw new Error(
            `seed=${seed} addr=${addr.toString(16)} expected=${expected} outputs=${outputs.join(",")}`,
          );
        }
      }
    }
  }, 120_000);
});

function formatForTest(network: bigint): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(((network >> BigInt((7 - i) * 16)) & 0xffffn).toString(16));
  }
  return groups.join(":");
}
