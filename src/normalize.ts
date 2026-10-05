import { ZoneParseError } from "./errors";
import type { ParseEntry, RecordEntry, Token } from "./parser";
import type { Rdata, ZoneRecord } from "./types";

/** Canonicalize an absolute name: lower-case, single trailing dot. */
function canonicalOrigin(origin: string): string {
  if (origin === "" || origin === ".") {
    return ".";
  }
  const trimmed = origin.endsWith(".") ? origin.slice(0, -1) : origin;
  return trimmed.toLowerCase() + ".";
}

/** Expand a written name against the current origin into canonical absolute form. */
function expandName(name: string, origin: string, line: number): string {
  if (name === "") {
    throw new ZoneParseError("empty domain name", line);
  }
  if (name === "@") {
    return origin;
  }
  if (name.endsWith(".")) {
    return canonicalOrigin(name);
  }
  if (origin === ".") {
    return name.toLowerCase() + ".";
  }
  return name.toLowerCase() + "." + origin;
}

function parseIpv4(token: string, line: number): string {
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new ZoneParseError(`invalid IPv4 address "${token}"`, line);
  }
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      throw new ZoneParseError(`invalid IPv4 address "${token}"`, line);
    }
    const value = Number(part);
    if (value > 255) {
      throw new ZoneParseError(`IPv4 octet out of range in "${token}"`, line);
    }
    return value;
  });
  return bytes.join(".");
}

/** Parse an IPv6 address (with "::" compression and optional embedded IPv4) into 16 bytes. */
function parseIpv6Bytes(token: string, line: number): number[] {
  let rest = token;
  let tailBytes: number[] | null = null;
  const v4Index = token.lastIndexOf(".");
  if (v4Index !== -1) {
    const v4Start = token.slice(0, v4Index).lastIndexOf(":") + 1;
    const v4 = token.slice(v4Start);
    const canonical = parseIpv4(v4, line);
    tailBytes = canonical.split(".").map(Number);
    rest = token.slice(0, v4Start) + "0:0";
    if (rest.endsWith("::0:0")) {
      rest = rest.slice(0, -3);
    }
  }
  const halves = rest.split("::");
  if (halves.length > 2) {
    throw new ZoneParseError(`invalid IPv6 address "${token}"`, line);
  }
  const parseGroups = (text: string): number[] => {
    if (text === "") {
      return [];
    }
    return text.split(":").map((group) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        throw new ZoneParseError(`invalid IPv6 address "${token}"`, line);
      }
      return parseInt(group, 16);
    });
  };
  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  const groups = [...head, ...tail];
  if (halves.length === 1 && groups.length !== 8) {
    throw new ZoneParseError(`invalid IPv6 address "${token}"`, line);
  }
  if (halves.length === 2 && groups.length > 7) {
    throw new ZoneParseError(`invalid IPv6 address "${token}"`, line);
  }
  const missing = 8 - groups.length;
  const full = [...head, ...Array<number>(missing).fill(0), ...tail];
  const bytes: number[] = [];
  for (const group of full) {
    bytes.push(group >> 8, group & 0xff);
  }
  if (tailBytes !== null) {
    bytes.splice(12, 4, ...tailBytes);
  }
  return bytes;
}

function canonicalIpv6(token: string, line: number): string {
  const bytes = parseIpv6Bytes(token, line);
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16).padStart(4, "0"));
  }
  return groups.join(":");
}

function requireUnquoted(token: Token | undefined, what: string, line: number): Token {
  if (token === undefined) {
    throw new ZoneParseError(`missing ${what}`, line);
  }
  if (token.quoted) {
    throw new ZoneParseError(`${what} must not be quoted`, token.line);
  }
  return token;
}

function buildRdata(entry: RecordEntry, origin: string): Rdata {
  const { type, rdata, line } = entry;
  switch (type) {
    case "A": {
      if (rdata.length !== 1) {
        throw new ZoneParseError("A record requires exactly one address", line);
      }
      const token = requireUnquoted(rdata[0], "A address", line);
      return { kind: "A", address: parseIpv4(token.value, token.line) };
    }
    case "AAAA": {
      if (rdata.length !== 1) {
        throw new ZoneParseError("AAAA record requires exactly one address", line);
      }
      const token = requireUnquoted(rdata[0], "AAAA address", line);
      return { kind: "AAAA", address: canonicalIpv6(token.value, token.line) };
    }
    case "CNAME": {
      if (rdata.length !== 1) {
        throw new ZoneParseError("CNAME record requires exactly one target", line);
      }
      const token = requireUnquoted(rdata[0], "CNAME target", line);
      return { kind: "CNAME", target: expandName(token.value, origin, token.line) };
    }
    case "NS": {
      if (rdata.length !== 1) {
        throw new ZoneParseError("NS record requires exactly one target", line);
      }
      const token = requireUnquoted(rdata[0], "NS target", line);
      return { kind: "NS", target: expandName(token.value, origin, token.line) };
    }
    case "MX": {
      if (rdata.length !== 2) {
        throw new ZoneParseError("MX record requires preference and exchange", line);
      }
      const prefToken = requireUnquoted(rdata[0], "MX preference", line);
      if (!/^\d+$/.test(prefToken.value)) {
        throw new ZoneParseError(`invalid MX preference "${prefToken.value}"`, prefToken.line);
      }
      const preference = Number(prefToken.value);
      if (preference > 0xffff) {
        throw new ZoneParseError("MX preference out of range 0-65535", prefToken.line);
      }
      const exchangeToken = requireUnquoted(rdata[1], "MX exchange", line);
      return { kind: "MX", preference, exchange: expandName(exchangeToken.value, origin, exchangeToken.line) };
    }
    case "TXT": {
      if (rdata.length === 0) {
        throw new ZoneParseError("TXT record requires at least one string", line);
      }
      const strings = rdata.map((token) => {
        if (!token.quoted) {
          throw new ZoneParseError("TXT rdata must be double-quoted strings", token.line);
        }
        if (token.value.length > 255) {
          throw new ZoneParseError("TXT string exceeds 255 bytes", token.line);
        }
        return token.value;
      });
      return { kind: "TXT", strings };
    }
  }
}

function rdataKey(rdata: Rdata): string {
  switch (rdata.kind) {
    case "A":
    case "AAAA":
      return rdata.address;
    case "CNAME":
    case "NS":
      return rdata.target;
    case "MX":
      return `${rdata.preference} ${rdata.exchange}`;
    case "TXT":
      return JSON.stringify(rdata.strings);
  }
}

/** Stable canonical key uniquely identifying a normalized record. */
export function recordKey(record: ZoneRecord): string {
  return `${record.owner} ${record.type} ${record.ttl} ${rdataKey(record.rdata)}`;
}

/** Normalize parsed entries into canonical, deduplicated, deterministically ordered records. */
export function normalizeRecords(origin: string, entries: readonly ParseEntry[]): ZoneRecord[] {
  let currentOrigin = canonicalOrigin(origin);
  let defaultTtl: number | undefined;
  let lastOwner: string | undefined;
  const byKey = new Map<string, ZoneRecord>();

  for (const entry of entries) {
    if (entry.kind === "origin") {
      currentOrigin = expandName(entry.name, currentOrigin, entry.line);
      continue;
    }
    if (entry.kind === "ttl") {
      defaultTtl = entry.ttl;
      continue;
    }
    let owner: string;
    if (entry.owner === null) {
      if (lastOwner === undefined) {
        throw new ZoneParseError("record omits owner before any owner was seen", entry.line);
      }
      owner = lastOwner;
    } else {
      owner = expandName(entry.owner, currentOrigin, entry.line);
      lastOwner = owner;
    }
    let ttl: number;
    if (entry.ttl !== null) {
      ttl = entry.ttl;
    } else if (defaultTtl !== undefined) {
      ttl = defaultTtl;
    } else {
      throw new ZoneParseError("record omits TTL but no $TTL default is set", entry.line);
    }
    const record: ZoneRecord = { owner, type: entry.type, ttl, rdata: buildRdata(entry, currentOrigin) };
    const key = recordKey(record);
    if (!byKey.has(key)) {
      byKey.set(key, record);
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const ka = recordKey(a);
    const kb = recordKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
