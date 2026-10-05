import type { LexToken } from "./lexer.ts";
import { toAbsolute } from "./parser.ts";
import { ZoneParseError, type Rdata, type RecordType } from "./types.ts";

function needUnquoted(tokens: LexToken[], type: string): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.quoted) {
      throw new ZoneParseError(`quoted string not allowed in ${type} RDATA`);
    }
    out.push(token.text);
  }
  return out;
}

function parseA(token: string): [number, number, number, number] {
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new ZoneParseError(`invalid A address: ${token}`);
  }
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      throw new ZoneParseError(`invalid A address: ${token}`);
    }
    const value = Number(part);
    if (value > 255) {
      throw new ZoneParseError(`A octet out of range: ${token}`);
    }
    return value;
  });
  return octets as [number, number, number, number];
}

function parseIpv4Tail(token: string): number[] {
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new ZoneParseError(`invalid IPv4 tail: ${token}`);
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) {
      throw new ZoneParseError(`invalid IPv4 tail: ${token}`);
    }
    bytes.push(Number(part));
  }
  return bytes;
}

/** Parse an IPv6 address to its 16-byte representation. */
export function parseAaaa(token: string): Uint8Array {
  if (token.includes("::")) {
    if (token.indexOf("::") !== token.lastIndexOf("::")) {
      throw new ZoneParseError(`invalid AAAA address: ${token}`);
    }
  }
  const [headPart, tailPart] = token.split("::") as [string, string?];
  const parseGroups = (section: string): number[] => {
    if (section === "") {
      return [];
    }
    const groups = section.split(":");
    const bytes: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (group.includes(".")) {
        if (i !== groups.length - 1) {
          throw new ZoneParseError(`invalid AAAA address: ${token}`);
        }
        bytes.push(...parseIpv4Tail(group));
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) {
        throw new ZoneParseError(`invalid AAAA address: ${token}`);
      }
      const value = parseInt(group, 16);
      bytes.push(value >> 8, value & 0xff);
    }
    return bytes;
  };
  const head = parseGroups(headPart);
  if (tailPart === undefined) {
    if (head.length !== 16) {
      throw new ZoneParseError(`invalid AAAA address: ${token}`);
    }
    return new Uint8Array(head);
  }
  const tail = parseGroups(tailPart);
  const missing = 16 - head.length - tail.length;
  if (missing < 2) {
    throw new ZoneParseError(`invalid AAAA address: ${token}`);
  }
  const bytes = [...head, ...new Array<number>(missing).fill(0), ...tail];
  return new Uint8Array(bytes);
}

/** Decode one quoted TXT chunk to bytes; max 255 bytes per chunk. */
export function decodeTxtChunk(raw: string): Uint8Array {
  const bytes: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) {
        throw new ZoneParseError("dangling backslash in TXT chunk");
      }
      if (/^\d$/.test(next)) {
        const digits = raw.slice(i + 1, i + 4);
        if (!/^\d{3}$/.test(digits)) {
          throw new ZoneParseError(
            `invalid decimal escape in TXT chunk: \\${digits}`,
          );
        }
        const value = Number(digits);
        if (value > 255) {
          throw new ZoneParseError(`decimal escape out of range: \\${digits}`);
        }
        bytes.push(value);
        i += 4;
        continue;
      }
      bytes.push(next.charCodeAt(0));
      i += 2;
      continue;
    }
    bytes.push(ch.charCodeAt(0));
    i++;
  }
  if (bytes.length > 255) {
    throw new ZoneParseError("TXT chunk exceeds 255 bytes");
  }
  return new Uint8Array(bytes);
}

/** Parse and normalize RDATA tokens for a record type. */
export function parseRdata(
  type: RecordType,
  tokens: LexToken[],
  origin: string,
): Rdata {
  switch (type) {
    case "A": {
      const parts = needUnquoted(tokens, type);
      if (parts.length !== 1) {
        throw new ZoneParseError("A record takes exactly one RDATA token");
      }
      return { kind: "A", octets: parseA(parts[0]!) };
    }
    case "AAAA": {
      const parts = needUnquoted(tokens, type);
      if (parts.length !== 1) {
        throw new ZoneParseError("AAAA record takes exactly one RDATA token");
      }
      return { kind: "AAAA", bytes: parseAaaa(parts[0]!) };
    }
    case "CNAME":
    case "NS": {
      const parts = needUnquoted(tokens, type);
      if (parts.length !== 1) {
        throw new ZoneParseError(`${type} record takes exactly one RDATA token`);
      }
      return { kind: type, target: toAbsolute(parts[0]!, origin) };
    }
    case "MX": {
      const parts = needUnquoted(tokens, type);
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]!)) {
        throw new ZoneParseError("MX record takes a preference and an exchange");
      }
      const preference = Number(parts[0]);
      if (preference > 65535) {
        throw new ZoneParseError(`MX preference out of range: ${parts[0]}`);
      }
      return {
        kind: "MX",
        preference,
        exchange: toAbsolute(parts[1]!, origin),
      };
    }
    case "TXT": {
      const chunks: Uint8Array[] = [];
      for (const token of tokens) {
        if (!token.quoted) {
          throw new ZoneParseError("TXT RDATA must be quoted strings");
        }
        chunks.push(decodeTxtChunk(token.text));
      }
      return { kind: "TXT", chunks };
    }
  }
}
