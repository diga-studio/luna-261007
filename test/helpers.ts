// Test-side independent helpers (deliberately not reusing src/ip.ts parsing,
// so the reference checks stay honest).

export function v4ToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`bad ipv4: ${ip}`);
  }
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

export function parseV4CidrTest(cidr: string): { start: number; len: number } {
  const [ip, lenStr] = cidr.split("/");
  const len = Number(lenStr);
  const start = v4ToNum(ip) & (len === 0 ? 0 : -1 << (32 - len));
  return { start: start >>> 0, len };
}

/** Independent IPv6 parser for verifying library output (no embedded v4 needed). */
export function parseV6Test(addr: string): bigint {
  if (addr.includes(".")) throw new Error(`unexpected embedded v4: ${addr}`);
  const dc = addr.indexOf("::");
  const head = (dc >= 0 ? addr.slice(0, dc) : addr).split(":").filter((p) => p.length > 0);
  const tail = dc >= 0 ? addr.slice(dc + 2).split(":").filter((p) => p.length > 0) : [];
  const groups = [...head, ...new Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8) throw new Error(`bad ipv6: ${addr}`);
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(parseInt(g, 16));
  return value;
}

export function parseCidrTest(cidr: string): { family: 4 | 6; start: bigint; len: number } {
  const slash = cidr.indexOf("/");
  const addr = cidr.slice(0, slash);
  const len = Number(cidr.slice(slash + 1));
  if (addr.includes(":")) {
    const shift = BigInt(128 - len);
    return { family: 6, start: (parseV6Test(addr) >> shift) << shift, len };
  }
  const shift = BigInt(32 - len);
  return { family: 4, start: (BigInt(v4ToNum(addr)) >> shift) << shift, len };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export function cidrEndExclusive(start: bigint, family: 4 | 6, len: number): bigint {
  return start + (1n << BigInt((family === 4 ? 32 : 128) - len));
}

/** Test-side IPv6 formatter (uncompressed), independent from src/ip.ts. */
export function formatV6Test(value: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  return groups.join(":");
}

/** Test-side IPv4 formatter. */
export function formatV4Test(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

/** Seeded PRNG (mulberry32) for reproducible scale tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
