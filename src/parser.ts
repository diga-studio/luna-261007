import { ZoneParseError } from "./errors";
import type { RecordType } from "./types";

/** A lexed token; `value` is escape-decoded, `quoted` marks double-quoted fragments. */
export interface Token {
  readonly value: string;
  readonly quoted: boolean;
  readonly line: number;
}

export interface OriginEntry {
  readonly kind: "origin";
  /** Name as written (may be relative or "@"). */
  readonly name: string;
  readonly line: number;
}

export interface TtlEntry {
  readonly kind: "ttl";
  readonly ttl: number;
  readonly line: number;
}

export interface RecordEntry {
  readonly kind: "record";
  /** Owner as written, or null when omitted via leading whitespace. */
  readonly owner: string | null;
  /** Explicit TTL in seconds, or null to use the current $TTL default. */
  readonly ttl: number | null;
  readonly type: RecordType;
  readonly rdata: readonly Token[];
  readonly line: number;
}

export type ParseEntry = OriginEntry | TtlEntry | RecordEntry;

const RECORD_TYPES: ReadonlySet<string> = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);

const TTL_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/** Parse a TTL token: decimal seconds or unit combinations like "1w2d3h4m5s" (case-insensitive). */
export function parseTtl(token: string, line: number): number {
  if (!/^(\d+[wdhms]?)+$/i.test(token)) {
    throw new ZoneParseError(`invalid TTL "${token}"`, line);
  }
  let total = 0;
  for (const match of token.matchAll(/(\d+)([wdhms])?/gi)) {
    const amount = Number(match[1]);
    const unit = match[2] === undefined ? 1 : TTL_UNITS[match[2].toLowerCase()]!;
    total += amount * unit;
  }
  if (!Number.isSafeInteger(total) || total > 0xffffffff) {
    throw new ZoneParseError(`TTL out of range "${token}"`, line);
  }
  return total;
}

/** Like parseTtl but returns null instead of throwing when the token is not TTL-shaped. */
function tryParseTtl(token: string): number | null {
  if (!/^(\d+[wdhms]?)+$/i.test(token)) {
    return null;
  }
  return parseTtl(token, -1);
}

interface LogicalLine {
  readonly tokens: Token[];
  readonly leadingWhitespace: boolean;
  readonly line: number;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Decode a backslash escape starting at text[i] (the backslash). Returns [char, nextIndex]. */
function decodeEscape(text: string, i: number, line: number): [string, number] {
  const next = text[i + 1];
  if (next === undefined) {
    throw new ZoneParseError("trailing backslash at end of input", line);
  }
  if (isDigit(next)) {
    const digits = text.slice(i + 1, i + 4);
    if (!/^\d{3}$/.test(digits)) {
      throw new ZoneParseError("numeric escape must have exactly three digits", line);
    }
    const value = Number(digits);
    if (value > 255) {
      throw new ZoneParseError(`numeric escape \\${digits} out of range 0-255`, line);
    }
    return [String.fromCharCode(value), i + 4];
  }
  return [next, i + 2];
}

/** Split master-file text into logical lines, handling comments, quotes and parentheses. */
function lexLogicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let tokens: Token[] = [];
  let leadingWhitespace = false;
  let atLineStart = true;
  let parenDepth = 0;
  let line = 1;
  let logicalLineStart = 1;

  const flush = () => {
    if (tokens.length > 0) {
      lines.push({ tokens, leadingWhitespace, line: logicalLineStart });
      tokens = [];
    }
    leadingWhitespace = false;
    atLineStart = true;
    logicalLineStart = line + 1;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t") {
      if (atLineStart) {
        leadingWhitespace = true;
      }
      i++;
    } else if (ch === "\n") {
      line++;
      i++;
      if (parenDepth === 0) {
        flush();
        logicalLineStart = line;
      }
    } else if (ch === ";") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
    } else if (ch === "(") {
      parenDepth++;
      atLineStart = false;
      i++;
    } else if (ch === ")") {
      if (parenDepth === 0) {
        throw new ZoneParseError("unmatched ')'", line);
      }
      parenDepth--;
      atLineStart = false;
      i++;
    } else if (ch === '"') {
      atLineStart = false;
      const tokenLine = line;
      let value = "";
      i++;
      let closed = false;
      while (i < text.length) {
        const c = text[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "\n") {
          throw new ZoneParseError("bare newline inside quoted string", line);
        }
        if (c === "\\") {
          const [decoded, next] = decodeEscape(text, i, line);
          if (decoded === "\n") {
            line++;
          }
          value += decoded;
          i = next;
        } else {
          value += c;
          i++;
        }
      }
      if (!closed) {
        throw new ZoneParseError("unterminated quoted string", tokenLine);
      }
      tokens.push({ value, quoted: true, line: tokenLine });
    } else {
      atLineStart = false;
      const tokenLine = line;
      let value = "";
      while (i < text.length) {
        const c = text[i]!;
        if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "(" || c === ")" || c === '"') {
          break;
        }
        if (c === "\\") {
          const [decoded, next] = decodeEscape(text, i, line);
          value += decoded;
          i = next;
        } else {
          value += c;
          i++;
        }
      }
      tokens.push({ value, quoted: false, line: tokenLine });
    }
  }
  if (parenDepth !== 0) {
    throw new ZoneParseError("unclosed '('", logicalLineStart);
  }
  flush();
  return lines;
}

function parseDirective(tokens: readonly Token[], line: number): ParseEntry {
  const directive = tokens[0]!.value.toUpperCase();
  if (directive === "$ORIGIN") {
    if (tokens.length !== 2 || tokens[1]!.quoted) {
      throw new ZoneParseError("$ORIGIN requires exactly one name argument", line);
    }
    return { kind: "origin", name: tokens[1]!.value, line };
  }
  if (directive === "$TTL") {
    if (tokens.length !== 2 || tokens[1]!.quoted) {
      throw new ZoneParseError("$TTL requires exactly one TTL argument", line);
    }
    return { kind: "ttl", ttl: parseTtl(tokens[1]!.value, tokens[1]!.line), line };
  }
  throw new ZoneParseError(`unsupported directive "${tokens[0]!.value}"`, line);
}

function parseRecord(entry: LogicalLine): ParseEntry {
  const { tokens, leadingWhitespace, line } = entry;
  let idx = 0;
  let owner: string | null = null;
  if (!leadingWhitespace) {
    if (tokens[0]!.quoted) {
      throw new ZoneParseError("owner name must not be quoted", tokens[0]!.line);
    }
    owner = tokens[0]!.value;
    idx = 1;
  }
  let ttl: number | null = null;
  let classSeen = false;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok.quoted) {
      break;
    }
    const upper = tok.value.toUpperCase();
    if (upper === "IN" && !classSeen) {
      classSeen = true;
      idx++;
      continue;
    }
    if (ttl === null) {
      const parsed = tryParseTtl(tok.value);
      if (parsed !== null) {
        ttl = parsed;
        idx++;
        continue;
      }
    }
    break;
  }
  if (idx >= tokens.length || tokens[idx]!.quoted) {
    throw new ZoneParseError("missing record type", line);
  }
  const typeToken = tokens[idx]!;
  const type = typeToken.value.toUpperCase();
  if (!RECORD_TYPES.has(type)) {
    throw new ZoneParseError(`unsupported record type "${typeToken.value}"`, typeToken.line);
  }
  idx++;
  const rdata = tokens.slice(idx);
  return { kind: "record", owner, ttl, type: type as RecordType, rdata, line };
}

/** Parse master-file text into a sequence of directive/record entries. Throws on any syntax error. */
export function parseZone(text: string): ParseEntry[] {
  if (/[^\x00-\x7f]/.test(text)) {
    throw new ZoneParseError("input must be ASCII");
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const entries: ParseEntry[] = [];
  for (const logicalLine of lexLogicalLines(normalized)) {
    const first = logicalLine.tokens[0]!;
    if (!first.quoted && first.value.startsWith("$")) {
      entries.push(parseDirective(logicalLine.tokens, logicalLine.line));
    } else {
      entries.push(parseRecord(logicalLine));
    }
  }
  return entries;
}
