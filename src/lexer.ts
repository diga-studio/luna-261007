import { ZoneParseError } from "./types.ts";

/**
 * Master-file lexer: splits text into logical entries, handling
 * comments, parentheses (multi-line grouping) and quoted strings.
 */

export interface LexToken {
  /** Token text; quoted tokens keep raw inner text (escapes undecoded). */
  text: string;
  quoted: boolean;
}

/** One logical entry: a record or directive, possibly spanning lines. */
export interface LexEntry {
  /** True when the entry's first physical line began with whitespace. */
  leadingBlank: boolean;
  tokens: LexToken[];
}

function isBlank(ch: string): boolean {
  return ch === " " || ch === "\t";
}

export function lexZone(text: string): LexEntry[] {
  if (/\r(?!\n)/.test(text) || /\r$/.test(text)) {
    // Allow CRLF only; a lone CR is outside the supported subset.
    const cleaned = text.replace(/\r\n/g, "\n");
    if (cleaned.includes("\r")) {
      throw new ZoneParseError("bare carriage return in input");
    }
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const entries: LexEntry[] = [];
  let current: LexToken[] = [];
  let entryLeadingBlank = false;
  let entryStarted = false;
  let depth = 0;

  const flush = (): void => {
    if (current.length > 0) {
      entries.push({ leadingBlank: entryLeadingBlank, tokens: current });
    }
    current = [];
    entryStarted = false;
    entryLeadingBlank = false;
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]!;
    let i = 0;
    if (!entryStarted) {
      entryLeadingBlank = line.length > 0 && isBlank(line[0]!);
      entryStarted = true;
    }
    while (i < line.length) {
      const ch = line[i]!;
      if (isBlank(ch)) {
        i++;
        continue;
      }
      if (ch === ";") {
        break; // comment to end of line
      }
      if (ch === "(") {
        depth++;
        i++;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) {
          throw new ZoneParseError(`unmatched ")" on line ${lineNo + 1}`);
        }
        depth--;
        i++;
        continue;
      }
      if (ch === '"') {
        // Quoted token: scan to closing quote on the same line.
        let j = i + 1;
        let raw = "";
        let closed = false;
        while (j < line.length) {
          const c = line[j]!;
          if (c === "\\") {
            if (j + 1 >= line.length) {
              throw new ZoneParseError(
                `unterminated quote on line ${lineNo + 1}`,
              );
            }
            raw += line[j]! + line[j + 1]!;
            j += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            j++;
            break;
          }
          raw += c;
          j++;
        }
        if (!closed) {
          throw new ZoneParseError(`unterminated quote on line ${lineNo + 1}`);
        }
        current.push({ text: raw, quoted: true });
        i = j;
        continue;
      }
      // Unquoted token: read until blank, ;, (, ) or quote.
      let j = i;
      while (j < line.length) {
        const c = line[j]!;
        if (isBlank(c) || c === ";" || c === "(" || c === ")" || c === '"') {
          break;
        }
        j++;
      }
      current.push({ text: line.slice(i, j), quoted: false });
      i = j;
    }
    if (depth === 0) {
      flush();
    }
  }
  if (depth !== 0) {
    throw new ZoneParseError("unclosed parenthesis at end of input");
  }
  flush();
  return entries;
}
