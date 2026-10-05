/**
 * IP address and CIDR parsing/formatting primitives.
 *
 * All addresses are represented as BigInt in the host byte order of the
 * address family: IPv4 uses the low 32 bits, IPv6 uses the low 128 bits.
 * IPv4-mapped IPv6 addresses remain in the IPv6 space and are never
 * collapsed to IPv4.
 */

export const Family = { V4: 4, V6: 6 } as const;
export type Family = (typeof Family)[keyof typeof Family];

export const MAX_BITS: Record<Family, number> = {
  [Family.V4]: 32,
  [Family.V6]: 128,
};

export interface ParsedCidr {
  family: Family;
  /** Network address with host bits already zeroed. */
  network: bigint;
  /** Prefix length: 0..32 for IPv4, 0..128 for IPv6. */
  prefixLen: number;
}

function parseIpv4Addr(text: string): bigint {
  const parts = text.split(".");
  if (parts.length !== 4) throw new Error(`invalid IPv4 address: ${text}`);
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`invalid IPv4 address: ${text}`);
    const octet = Number(part);
    if (octet > 255) throw new Error(`invalid IPv4 address: ${text}`);
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6Addr(text: string): bigint {
  // An embedded dotted-quad IPv4 tail (e.g. "::ffff:192.0.2.1") counts as
  // two 16-bit groups. The address stays in the IPv6 space.
  let tailGroups: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = lastColon >= 0 ? text.slice(lastColon + 1) : "";
  let head = text;
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4Addr(maybeV4);
    tailGroups = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    // Keep the colon(s) preceding the IPv4 tail so "::" survives, then drop
    // a single separator colon if the head does not end in "::".
    head = text.slice(0, lastColon + 1);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }

  const parseGroups = (section: string): number[] => {
    if (section === "") return [];
    return section.split(":").map((group) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        throw new Error(`invalid IPv6 address: ${text}`);
      }
      return parseInt(group, 16);
    });
  };

  const doubleColon = head.indexOf("::");
  if (doubleColon !== head.lastIndexOf("::")) {
    throw new Error(`invalid IPv6 address: ${text}`);
  }

  let groups: number[];
  if (doubleColon >= 0) {
    const left = parseGroups(head.slice(0, doubleColon));
    const right = parseGroups(head.slice(doubleColon + 2));
    const missing = 8 - left.length - right.length - tailGroups.length;
    if (missing < 1) throw new Error(`invalid IPv6 address: ${text}`);
    groups = [...left, ...new Array<number>(missing).fill(0), ...right, ...tailGroups];
  } else {
    groups = [...parseGroups(head), ...tailGroups];
    if (groups.length !== 8) throw new Error(`invalid IPv6 address: ${text}`);
  }

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

/** Zero every bit below the top `prefixLen` bits of `maxBits`. */
export function maskNetwork(address: bigint, prefixLen: number, maxBits: number): bigint {
  if (prefixLen <= 0) return 0n;
  const hostBits = BigInt(maxBits - prefixLen);
  return (address >> hostBits) << hostBits;
}

/** Parse a CIDR string, zeroing any non-zero host bits. */
export function parseCidr(text: string): ParsedCidr {
  const slash = text.indexOf("/");
  if (slash < 0 || slash !== text.lastIndexOf("/")) {
    throw new Error(`invalid CIDR: ${text}`);
  }
  const addrText = text.slice(0, slash);
  const lenText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(lenText)) throw new Error(`invalid CIDR: ${text}`);
  const prefixLen = Number(lenText);

  const family = addrText.includes(":") ? Family.V6 : Family.V4;
  const maxBits = MAX_BITS[family];
  if (prefixLen > maxBits) throw new Error(`invalid CIDR: ${text}`);
  const address = family === Family.V6 ? parseIpv6Addr(addrText) : parseIpv4Addr(addrText);
  return { family, network: maskNetwork(address, prefixLen, maxBits), prefixLen };
}

function formatIpv4(value: bigint): string {
  const parts: string[] = [];
  for (let shift = 24n; shift >= 0n; shift -= 8n) {
    parts.push(((value >> shift) & 0xffn).toString(10));
  }
  return parts.join(".");
}

function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
  }
  // Compress the longest run of zero groups (length >= 2); first run wins ties.
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen >= 2) {
    const left = hex.slice(0, bestStart).join(":");
    const right = hex.slice(bestStart + bestLen).join(":");
    return `${left}::${right}`;
  }
  return hex.join(":");
}

/** Format a normalized network address + prefix length back to a CIDR string. */
export function formatCidr(family: Family, network: bigint, prefixLen: number): string {
  const addr = family === Family.V6 ? formatIpv6(network) : formatIpv4(network);
  return `${addr}/${prefixLen}`;
}
