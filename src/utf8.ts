// DFA-based UTF-8 validation (B. Hoehrmann's decoder, validation only).
const UTF8_ACCEPT = 0;
const UTF8_REJECT = 12;

// prettier-ignore
const DFA: readonly number[] = [
  // The first part of the table maps bytes to character classes
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,  9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  8,8,2,2,2,2,2,2,2,2,2,2,2,2,2,2,  2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
  10,3,3,3,3,3,3,3,3,3,3,3,3,4,3,3, 11,6,6,6,5,8,8,8,8,8,8,8,8,8,8,8,
  // The second part is a transition table that maps a combination
  // of a state and a character class to a new state.
  0,12,24,36,60,96,84,12,12,12,48,72, 12,12,12,12,12,12,12,12,12,12,12,12,
  12, 0,12,12,12,12,12, 0,12, 0,12,12, 12,24,12,12,12,12,12,24,12,24,12,12,
  12,12,12,12,12,12,12,24,12,12,12,12, 12,24,12,12,12,12,12,12,12,24,12,12,
  12,12,12,12,12,12,12,36,12,36,12,12, 12,36,12,12,12,12,12,36,12,36,12,12,
  12,36,12,12,12,12,12,12,12,12,12,12,
];

/**
 * Incremental UTF-8 validator. Bytes may be split anywhere, including
 * inside multi-byte sequences. Rejects overlongs, surrogates, and
 * code points above U+10FFFF.
 */
export class Utf8Validator {
  private state = UTF8_ACCEPT;

  /** Returns false as soon as an invalid sequence is seen. */
  push(chunk: Uint8Array): boolean {
    if (this.state === UTF8_REJECT) return false;
    let state = this.state;
    for (let i = 0; i < chunk.length; i++) {
      state = DFA[256 + state + DFA[chunk[i]!]!]!;
      if (state === UTF8_REJECT) {
        this.state = UTF8_REJECT;
        return false;
      }
    }
    this.state = state;
    return true;
  }

  /** True iff all bytes so far form complete, valid UTF-8 (no dangling prefix). */
  isComplete(): boolean {
    return this.state === UTF8_ACCEPT;
  }
}
