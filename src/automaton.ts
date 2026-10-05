/**
 * Aho-Corasick automaton over normalized words (code-point sequences).
 *
 * The automaton is built once from the wordlist and then stays immutable in
 * behaviour: search only reads it. Outputs are merged along failure links at
 * build time, so scanning never walks the failure chain to collect matches.
 */

export interface AutomatonMatch {
  wordId: number;
  /** Index of the first normalized code point of the match. */
  start: number;
  /** Index one past the last normalized code point of the match. */
  end: number;
}

export class Automaton {
  private transitions: Array<Map<number, number>> = [new Map()];
  private outputs: number[][] = [[]];
  private fail: number[] = [0];
  private wordLengths: number[] = [];
  private built = false;

  /** Add a normalized (non-empty) word associated with an internal numeric id. */
  addWord(wordId: number, normalizedWord: readonly number[]): void {
    if (this.built) {
      throw new Error("automaton is already built");
    }
    if (normalizedWord.length === 0) {
      throw new Error("normalized word must not be empty");
    }
    let node = 0;
    for (const cp of normalizedWord) {
      const next = this.transitions[node].get(cp);
      if (next === undefined) {
        const created = this.transitions.length;
        this.transitions.push(new Map());
        this.outputs.push([]);
        this.fail.push(0);
        this.transitions[node].set(cp, created);
        node = created;
      } else {
        node = next;
      }
    }
    this.outputs[node].push(wordId);
    this.wordLengths[wordId] = normalizedWord.length;
  }

  /** Freeze the automaton. Must be called after all addWord calls. */
  build(): void {
    if (this.built) {
      return;
    }
    // Breadth-first construction of failure links; outputs of the failure
    // target are merged so every node carries the matches of its suffixes.
    const queue: number[] = [];
    for (const child of this.transitions[0].values()) {
      queue.push(child);
    }
    let head = 0;
    while (head < queue.length) {
      const node = queue[head++];
      for (const [cp, child] of this.transitions[node]) {
        let fallback = this.fail[node];
        while (fallback !== 0 && !this.transitions[fallback].has(cp)) {
          fallback = this.fail[fallback];
        }
        const target = this.transitions[fallback].get(cp);
        this.fail[child] = target === undefined ? 0 : target;
        const inherited = this.outputs[this.fail[child]];
        if (inherited.length !== 0) {
          this.outputs[child] = this.outputs[child].concat(inherited);
        }
        queue.push(child);
      }
    }
    this.built = true;
  }

  /**
   * Scan normalized text and invoke onMatch for the earliest match of each
   * word id only (later matches of the same id are skipped). Because matches
   * surface in order of increasing end index and each word has a fixed
   * length, the first match reported for a word is also the one with the
   * smallest start index.
   */
  searchEarlyPerWord(
    codePoints: Uint32Array,
    onMatch: (match: AutomatonMatch) => void,
  ): void {
    if (!this.built) {
      throw new Error("automaton is not built");
    }
    const transitions = this.transitions;
    const fail = this.fail;
    const outputs = this.outputs;
    const wordLengths = this.wordLengths;
    const reported = new Uint8Array(wordLengths.length);
    let node = 0;
    for (let index = 0; index < codePoints.length; index++) {
      const cp = codePoints[index];
      let next = transitions[node].get(cp);
      while (next === undefined && node !== 0) {
        node = fail[node];
        next = transitions[node].get(cp);
      }
      node = next === undefined ? 0 : next;
      const out = outputs[node];
      for (let k = 0; k < out.length; k++) {
        const wordId = out[k];
        if (reported[wordId] === 0) {
          reported[wordId] = 1;
          onMatch({
            wordId,
            start: index - wordLengths[wordId] + 1,
            end: index + 1,
          });
        }
      }
    }
  }
}
