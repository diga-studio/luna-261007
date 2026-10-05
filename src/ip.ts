import type { Family } from "./types.ts";

export function familyBits(family: Family): number {
  return family === 4 ? 32 : 128;
}

function parseV4(addr: string): bigint {
  const parts = addr.split(".");
  if (parts.length !== 4) throw new Error(`invalid IPv4 address: ${addr}`);
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`invalid IPv4 address: ${addr}`);
    const octet = Number(part);
    if (octet > 255) throw new Error(`invalid IPv4 address: ${addr}`);
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseV6(addr: string): bigint {
  let s = addr;
  // Expand an embedded IPv4 tail (e.g. "::ffff:192.0.2.1") into two hex groups.
  const v4match = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4match) {
    const v4 = parseV4(v4match[1]);
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    s = s.slice(0, s.length - v4match[1].length) + hi + ":" + lo;
  }
  const dc = s.indexOf("::");
  if (dc !== s.lastIndexOf("::")) throw new Error(`invalid IPv6 address: ${addr}`);
  const head = (dc >= 0 ? s.slice(0, dc) : s).split(":").filter((p) => p.length > 0);
  const tail = dc >= 0 ? s.slice(dc + 2).split(":").filter((p) => p.length > 0) : [];
  const missing = 8 - head.length - tail.length;
  if (dc < 0 && missing !== 0) throw new Error(`invalid IPv6 address: ${addr}`);
  if (dc >= 0 && missing < 0) throw new Error(`invalid IPv6 address: ${addr}`);
  const groups = [...head, ...new Array<string>(missing).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) throw new Error(`invalid IPv6 address: ${addr}`);
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

export function parseIp(addr: string): { family: Family; value: bigint } {
  if (addr.includes(":")) return { family: 6, value: parseV6(addr) };
  return { family: 4, value: parseV4(addr) };
}

/** Parse a CIDR string, clear host bits, return normalized form. */
export function parseCidr(cidr: string): { family: Family; start: bigint; len: number } {
  const slash = cidr.indexOf("/");
  const addr = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const { family, value } = parseIp(addr);
  const bits = familyBits(family);
  const len = slash >= 0 ? Number(cidr.slice(slash + 1)) : bits;
  if (!Number.isInteger(len) || len < 0 || len > bits) {
    throw new Error(`invalid prefix length in CIDR: ${cidr}`);
  }
  const shift = BigInt(bits - len);
  const start = shift === 0n ? value : (value >> shift) << shift;
  return { family, start, len };
}

function formatV4(value: bigint): string {
  const parts: string[] = [];
  for (let i = 3; i >= 0; i--) parts.push(String((value >> BigInt(i * 8)) & 0xffn));
  return parts.join(".");
}

function formatV6(value: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952: compress the first longest run of >= 2 zero groups.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (curStart < 0) curStart = i;
    } else {
      const run = curStart >= 0 ? i - curStart : 0;
      if (run >= 2 && run > bestLen) {
        bestStart = curStart;
        bestLen = run;
      }
      curStart = -1;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

/** Format a normalized prefix as a CIDR string. */
export function formatCidr(family: Family, start: bigint, len: number): string {
  const addr = family === 4 ? formatV4(start) : formatV6(start);
  return `${addr}/${len}`;
}

function log2OfPowerOfTwo(v: bigint): number {
  // v is a positive power of two.
  return v.toString(2).length - 1;
}

/** Yield the minimal CIDR set covering [start, endExclusive), in ascending order. */
export function* rangeToCidrs(
  family: Family,
  start: bigint,
  endExclusive: bigint,
): Generator<string> {
  const bits = familyBits(family);
  let cur = start;
  while (cur < endExclusive) {
    // Largest block aligned at cur, capped by the remaining range.
    let size = cur === 0n ? 1n << BigInt(bits) : cur & -cur;
    const remaining = endExclusive - cur;
    while (size > remaining) size >>= 1n;
    yield formatCidr(family, cur, bits - log2OfPowerOfTwo(size));
    cur += size;
  }
}
