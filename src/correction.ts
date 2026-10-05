/**
 * Edit-distance-1 correction index over the vocabulary.
 *
 * Distance is measured in Unicode code points (insert / delete /
 * substitute only). A word w is at distance exactly 1 from q iff:
 *  - |w| = |q|   and they share a common single-char deletion (substitution), or
 *  - |w| = |q|+1 and q itself is a single-char deletion of w (insertion), or
 *  - |w| = |q|-1 and w itself is a single-char deletion of q (deletion).
 *
 * So indexing, for every vocab word w, the keys {w} ∪ deletes1(w) and
 * querying with keys {q} ∪ deletes1(q) finds exactly the distance-1
 * neighbors without scanning the vocabulary.
 *
 * A shared deletion key is necessary but not sufficient for distance 1
 * (e.g. "ab" vs "ba" share deletes but need two substitutions), so
 * candidates are verified with an exact check before being returned.
 */

/** Exact edit-distance-1 test over code point arrays. */
function isEditDistance1(a: string[], b: string[]): boolean {
  const la = a.length;
  const lb = b.length;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return diff === 1;
  }
  // Ensure a is the shorter one; check b is a plus one inserted char.
  const [short, long] = la < lb ? [a, b] : [b, a];
  if (long.length - short.length !== 1) return false;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else {
      return false;
    }
  }
  return true;
}

export class CorrectionIndex {
  /** key -> vocab words w with w == key or key ∈ deletes1(w) */
  private readonly index = new Map<string, string[]>();

  constructor(vocab: Iterable<string>) {
    for (const word of vocab) {
      this.add(word, word);
      const cps = Array.from(word);
      for (let i = 0; i < cps.length; i++) {
        this.add(cps.slice(0, i).join("") + cps.slice(i + 1).join(""), word);
      }
    }
  }

  private add(key: string, word: string): void {
    const list = this.index.get(key);
    if (list === undefined) {
      this.index.set(key, [word]);
    } else {
      list.push(word);
    }
  }

  /** All vocabulary words at edit distance exactly 1 from `word`. */
  neighbors(word: string): string[] {
    const cps = Array.from(word);
    const keys = new Set<string>();
    keys.add(word);
    for (let i = 0; i < cps.length; i++) {
      keys.add(cps.slice(0, i).join("") + cps.slice(i + 1).join(""));
    }
    const result = new Set<string>();
    for (const key of keys) {
      const list = this.index.get(key);
      if (list === undefined) continue;
      for (const candidate of list) {
        if (candidate !== word && !result.has(candidate)) {
          if (isEditDistance1(cps, Array.from(candidate))) {
            result.add(candidate);
          }
        }
      }
    }
    return [...result];
  }
}
