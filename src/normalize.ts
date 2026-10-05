/**
 * Equivalence rules shared by wordlist entries and reviewed text:
 * - ASCII letters are case-insensitive;
 * - fullwidth ASCII variants (U+FF01..U+FF5E, plus ideographic space U+3000)
 *   equal their halfwidth counterparts;
 * - U+200B, U+200C, U+200D and U+FEFF are ignored;
 * - everything else matches literally (spaces, newlines, punctuation included).
 */

/** Code point returned by mapCodePoint when the character must be ignored. */
const DROPPED = -1;

function mapCodePoint(cp: number): number {
  // Ignored zero-width / BOM characters.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) {
    return DROPPED;
  }
  // Fullwidth ASCII variants -> halfwidth (U+FF01..U+FF5E -> U+0021..U+007E),
  // and ideographic space -> regular space.
  if (cp >= 0xff01 && cp <= 0xff5e) {
    cp -= 0xfee0;
  } else if (cp === 0x3000) {
    cp = 0x20;
  }
  // ASCII letters are case-insensitive.
  if (cp >= 0x41 && cp <= 0x5a) {
    cp += 0x20;
  }
  return cp;
}

export interface NormalizedText {
  /**
   * Normalized code points. Supplementary-plane characters are preserved as
   * single entries, so indexing is by Unicode code point, not UTF-16 unit.
   */
  codePoints: Uint32Array;
  /**
   * positions[i] is the UTF-16 offset in the original text where the code
   * point that produced codePoints[i] starts.
   */
  positions: Uint32Array;
  /**
   * widths[i] is the UTF-16 length (1 or 2) of the original code point that
   * produced codePoints[i].
   */
  widths: Uint8Array;
}

/** Normalize reviewed text, keeping a mapping back to original UTF-16 offsets. */
export function normalizeText(text: string): NormalizedText {
  const length = text.length;
  const codePoints = new Uint32Array(length);
  const positions = new Uint32Array(length);
  const widths = new Uint8Array(length);
  let count = 0;
  let index = 0;
  while (index < length) {
    const first = text.charCodeAt(index);
    let cp = first;
    let width = 1;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < length) {
      const second = text.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        cp = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        width = 2;
      }
    }
    const mapped = mapCodePoint(cp);
    if (mapped !== DROPPED) {
      codePoints[count] = mapped;
      positions[count] = index;
      widths[count] = width;
      count++;
    }
    index += width;
  }
  return {
    codePoints: codePoints.subarray(0, count),
    positions: positions.subarray(0, count),
    widths: widths.subarray(0, count),
  };
}

/**
 * Normalize a single wordlist word into code points.
 * Returns an empty array when nothing survives the equivalence rules.
 */
export function normalizeWord(word: string): number[] {
  const result: number[] = [];
  for (const char of word) {
    const mapped = mapCodePoint(char.codePointAt(0)!);
    if (mapped !== DROPPED) {
      result.push(mapped);
    }
  }
  return result;
}
