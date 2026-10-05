import type { LexEntry, LexToken } from "./lexer.ts";
import { ZoneParseError, type RecordType } from "./types.ts";

/** A parsed record with owner/TTL resolved; RDATA still tokenized. */
export interface RawRecord {
  owner: string; // absolute, lowercased, trailing dot
  type: RecordType;
  ttl: number;
  /** RDATA tokens in order (quoted TXT chunks keep raw escaped text). */
  rdata: LexToken[];
  /** Origin in effect for this record (for expanding RDATA names). */
  origin: string;
}

const RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);
const MAX_TTL = 2147483647; // 2^31 - 1

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/** Parse TTL: decimal seconds or unit combinations like "1w2d3h4m5s". */
export function parseTtl(token: string): number | null {
  if (!/^(\d+[wdhms]?)+$/i.test(token)) {
    return null;
  }
  let total = 0;
  const re = /(\d+)([wdhms]?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(token)) !== null) {
    const value = Number(m[1]);
    const unit = (m[2] ?? "").toLowerCase();
    total += value * (unit === "" ? 1 : UNIT_SECONDS[unit]!);
    if (total > MAX_TTL) {
      throw new ZoneParseError(`TTL out of range: ${token}`);
    }
  }
  return total;
}

function isTtlToken(token: string): boolean {
  return /^(\d+[wdhms]?)+$/i.test(token);
}

function validateLabels(name: string): void {
  if (name === ".") {
    return;
  }
  const body = name.endsWith(".") ? name.slice(0, -1) : name;
  if (body.length === 0) {
    return;
  }
  for (const label of body.split(".")) {
    if (!/^[*]?[A-Za-z0-9_-]+$/.test(label) && label !== "*") {
      throw new ZoneParseError(`invalid domain name label in "${name}"`);
    }
  }
}

/** Resolve a master-file name to absolute lowercase form with trailing dot. */
export function toAbsolute(name: string, origin: string): string {
  let absolute: string;
  if (name === "@") {
    absolute = origin;
  } else if (name.endsWith(".")) {
    absolute = name;
  } else if (origin === ".") {
    absolute = name + ".";
  } else {
    absolute = name + "." + origin;
  }
  absolute = absolute.toLowerCase();
  validateLabels(absolute);
  return absolute;
}

function normalizeOrigin(origin: string): string {
  const lower = origin.toLowerCase();
  const absolute = lower.endsWith(".") ? lower : lower + ".";
  validateLabels(absolute);
  return absolute;
}

export function parseZone(origin: string, entries: LexEntry[]): RawRecord[] {
  let currentOrigin = normalizeOrigin(origin);
  let defaultTtl: number | undefined;
  let lastOwner: string | undefined;
  const records: RawRecord[] = [];

  for (const entry of entries) {
    const tokens = entry.tokens;
    const first = tokens[0]!;

    if (!entry.leadingBlank && !first.quoted && first.text.startsWith("$")) {
      const directive = first.text.toUpperCase();
      if (directive === "$ORIGIN") {
        if (tokens.length !== 2 || tokens[1]!.quoted) {
          throw new ZoneParseError("invalid $ORIGIN directive");
        }
        // A relative $ORIGIN expands against the previous origin.
        currentOrigin = toAbsolute(tokens[1]!.text, currentOrigin);
      } else if (directive === "$TTL") {
        if (tokens.length !== 2 || tokens[1]!.quoted) {
          throw new ZoneParseError("invalid $TTL directive");
        }
        const ttl = parseTtl(tokens[1]!.text);
        if (ttl === null) {
          throw new ZoneParseError(`invalid $TTL value: ${tokens[1]!.text}`);
        }
        defaultTtl = ttl;
      } else {
        throw new ZoneParseError(`unsupported directive: ${first.text}`);
      }
      continue; // directives never touch lastOwner
    }

    let index = 0;
    let owner: string;
    if (entry.leadingBlank) {
      if (lastOwner === undefined) {
        throw new ZoneParseError("owner omitted before any record");
      }
      owner = lastOwner;
    } else {
      if (first.quoted) {
        throw new ZoneParseError("owner must not be quoted");
      }
      owner = toAbsolute(first.text, currentOrigin);
      lastOwner = owner;
      index = 1;
    }

    let ttl: number | undefined;
    let sawClass = false;
    let type: RecordType | undefined;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token.quoted) {
        break; // quoted token must be RDATA (TXT)
      }
      const upper = token.text.toUpperCase();
      if (!sawClass && upper === "IN") {
        sawClass = true;
        index++;
        continue;
      }
      if (ttl === undefined && isTtlToken(token.text)) {
        ttl = parseTtl(token.text)!;
        index++;
        continue;
      }
      if (RECORD_TYPES.has(upper)) {
        type = upper as RecordType;
        index++;
        break;
      }
      throw new ZoneParseError(`unexpected token "${token.text}" for ${owner}`);
    }
    if (type === undefined) {
      throw new ZoneParseError(`missing record type for ${owner}`);
    }
    if (ttl === undefined) {
      if (defaultTtl === undefined) {
        throw new ZoneParseError(`no TTL and no $TTL default for ${owner}`);
      }
      ttl = defaultTtl;
    }
    const rdata = tokens.slice(index);
    if (rdata.length === 0) {
      throw new ZoneParseError(`missing RDATA for ${owner} ${type}`);
    }
    records.push({ owner, type, ttl, rdata, origin: currentOrigin });
  }
  return records;
}
