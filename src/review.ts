import { readFileSync } from "node:fs";
import { Automaton } from "./automaton.js";
import { normalizeText, normalizeWord } from "./normalize.js";

/** Stable identifier of a wordlist entry, as stored in the JSON file. */
export type WordId = number | string;

export interface WordlistEntry {
  id: WordId;
  word: string;
}

export interface MatchHit {
  /** Wordlist entry id that was hit. */
  id: WordId;
  /** Start UTF-16 offset in the original text, inclusive, from 0. */
  start: number;
  /** End UTF-16 offset in the original text, exclusive. */
  end: number;
}

export interface ReviewResult {
  /** True when at least one wordlist entry matched. */
  blocked: boolean;
  /** One hit per matched entry id, ordered by start offset. */
  hits: MatchHit[];
}

/** Maximum reviewed text size: 4 MiB measured in UTF-8 bytes. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

function validateEntry(entry: unknown, index: number): WordlistEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new TypeError(`wordlist entry #${index} must be an object`);
  }
  const { id, word } = entry as Record<string, unknown>;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new TypeError(`wordlist entry #${index}: id must be a number or string`);
  }
  if (typeof word !== "string") {
    throw new TypeError(`wordlist entry #${index}: word must be a string`);
  }
  return { id, word };
}

/**
 * Immutable keyword reviewer. The wordlist is compiled once at construction
 * and never changes afterwards; instances are safe to reuse across reviews.
 */
export class KeywordReviewer {
  private readonly automaton: Automaton;
  private readonly ids: readonly WordId[];

  constructor(entries: readonly WordlistEntry[]) {
    const automaton = new Automaton();
    const ids: WordId[] = [];
    const seen = new Set<WordId>();
    entries.forEach((raw, index) => {
      const entry = validateEntry(raw, index);
      if (seen.has(entry.id)) {
        throw new Error(`duplicate wordlist id: ${String(entry.id)}`);
      }
      seen.add(entry.id);
      const normalized = normalizeWord(entry.word);
      if (normalized.length === 0) {
        throw new Error(
          `wordlist entry ${String(entry.id)} is empty after normalization`,
        );
      }
      automaton.addWord(ids.length, normalized);
      ids.push(entry.id);
    });
    automaton.build();
    this.automaton = automaton;
    this.ids = ids;
  }

  /**
   * Load a wordlist from a local JSON file. The file must contain an array
   * of {"id": number | string, "word": string} entries.
   */
  static loadFromFile(path: string): KeywordReviewer {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new TypeError("wordlist file must contain a JSON array");
    }
    return new KeywordReviewer(parsed as WordlistEntry[]);
  }

  /**
   * Review a single plain-text field. Returns whether the content is blocked
   * and, for every matched wordlist id, the earliest occurrence as a UTF-16
   * offset range into the original text.
   */
  review(text: string): ReviewResult {
    if (typeof text !== "string") {
      throw new TypeError("text must be a string");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      throw new RangeError("text exceeds the 4 MiB limit");
    }
    const { codePoints, positions, widths } = normalizeText(text);
    const ids = this.ids;
    const hits: MatchHit[] = [];
    this.automaton.searchEarlyPerWord(codePoints, (match) => {
      const last = match.end - 1;
      hits.push({
        id: ids[match.wordId],
        start: positions[match.start],
        end: positions[last] + widths[last],
      });
    });
    hits.sort((a, b) => a.start - b.start || a.end - b.end);
    return { blocked: hits.length > 0, hits };
  }
}
