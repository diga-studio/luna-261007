import type { CompiledNfa, NfaState } from "./nfa.js";

/**
 * Streaming matcher for a single compiled rule.
 * Simulates an NFA over the decoded body bytes; a match may start at any
 * position. `^` passes only at absolute position 0, `$` only at end().
 */
export class RuleMatcher {
  private active: Set<NfaState>;
  private matched = false;
  private ended = false;
  private pos = 0;

  constructor(private readonly nfa: CompiledNfa) {
    this.active = this.closure([nfa.start], true);
    if (this.active.has(nfa.accept)) this.matched = true;
  }

  /** Epsilon closure; assertion edges pass only when their condition holds. */
  private closure(
    seeds: Iterable<NfaState>,
    atStart: boolean,
    atEnd = false,
  ): Set<NfaState> {
    const result = new Set<NfaState>();
    const stack = [...seeds];
    while (stack.length > 0) {
      const state = stack.pop()!;
      if (result.has(state)) continue;
      result.add(state);
      for (const next of state.epsEdges) stack.push(next);
      if (atStart) for (const next of state.startAssertEdges) stack.push(next);
      if (atEnd) for (const next of state.endAssertEdges) stack.push(next);
    }
    return result;
  }

  /** Feed one chunk of decoded body bytes. Empty chunks are no-ops. */
  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error("cannot push after end()");
    if (this.matched || chunk.length === 0) return;
    for (let i = 0; i < chunk.length; i++) {
      this.pos++;
      const byte = chunk[i];
      const seeds: NfaState[] = [];
      for (const state of this.active) {
        for (const [lo, hi, target] of state.byteEdges) {
          if (byte >= lo && byte <= hi) seeds.push(target);
        }
      }
      // A new match attempt may start at the next position.
      seeds.push(this.nfa.start);
      // Position after consuming a byte is never the absolute start.
      this.active = this.closure(seeds, false);
      if (this.active.has(this.nfa.accept)) {
        this.matched = true;
        return;
      }
    }
  }

  /** Signal absolute end of body; returns whether the rule matched. */
  end(): boolean {
    if (!this.ended) {
      this.ended = true;
      if (!this.matched) {
        // `$` passes only now, at the absolute end of the body; if no bytes
        // were ever consumed this position is also the absolute start.
        const finalStates = this.closure(this.active, this.pos === 0, true);
        if (finalStates.has(this.nfa.accept)) this.matched = true;
      }
    }
    return this.matched;
  }
}
