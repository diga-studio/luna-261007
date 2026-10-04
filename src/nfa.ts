import type { AstNode } from './parser';

/** A compiled, streamable matcher for a single pattern. */
export interface CompiledMatcher {
  /** Feed one byte. */
  advance(byte: number): void;
  /** Signal end of body; returns true if the pattern matched anywhere. */
  finish(): boolean;
  /** Whether the pattern has already matched (before or at finish). */
  readonly matched: boolean;
}

interface ByteEdge {
  readonly test: (byte: number) => boolean;
  readonly target: number;
}

interface State {
  byteEdges: ByteEdge[];
  epsEdges: number[];
  startAnchorEdges: number[];
  endAnchorEdges: number[];
  accepting: boolean;
}

class NfaBuilder {
  readonly states: State[] = [];

  newState(): number {
    this.states.push({
      byteEdges: [],
      epsEdges: [],
      startAnchorEdges: [],
      endAnchorEdges: [],
      accepting: false,
    });
    return this.states.length - 1;
  }

  /** Builds a fragment; returns [start, accept] state ids. */
  build(node: AstNode): [number, number] {
    switch (node.kind) {
      case 'empty': {
        const s = this.newState();
        const a = this.newState();
        this.states[s].epsEdges.push(a);
        return [s, a];
      }
      case 'literal': {
        const byte = node.byte;
        return this.byteFragment((b) => b === byte);
      }
      case 'dot':
        return this.byteFragment(() => true);
      case 'class': {
        const table = new Uint8Array(256);
        for (const [lo, hi] of node.ranges) {
          for (let b = lo; b <= hi; b++) table[b] = 1;
        }
        const test = node.negated
          ? (b: number) => table[b] === 0
          : (b: number) => table[b] === 1;
        return this.byteFragment(test);
      }
      case 'concat': {
        const s = this.newState();
        const a = this.newState();
        let prev = s;
        for (const part of node.parts) {
          const [ps, pa] = this.build(part);
          this.states[prev].epsEdges.push(ps);
          prev = pa;
        }
        this.states[prev].epsEdges.push(a);
        return [s, a];
      }
      case 'alt': {
        const s = this.newState();
        const a = this.newState();
        for (const branch of node.branches) {
          const [bs, ba] = this.build(branch);
          this.states[s].epsEdges.push(bs);
          this.states[ba].epsEdges.push(a);
        }
        return [s, a];
      }
      case 'repeat': {
        const [subStart, subAccept] = this.build(node.node);
        const s = this.newState();
        const a = this.newState();
        if (node.min === 0) this.states[s].epsEdges.push(a);
        this.states[s].epsEdges.push(subStart);
        this.states[subAccept].epsEdges.push(a);
        if (node.max === null) {
          // Loop back for unbounded repetition. For min=1 the first pass is
          // mandatory, which the edges above already enforce.
          this.states[subAccept].epsEdges.push(subStart);
        }
        return [s, a];
      }
      case 'startAnchor': {
        const s = this.newState();
        const a = this.newState();
        this.states[s].startAnchorEdges.push(a);
        return [s, a];
      }
      case 'endAnchor': {
        const s = this.newState();
        const a = this.newState();
        this.states[s].endAnchorEdges.push(a);
        return [s, a];
      }
    }
  }

  private byteFragment(test: (byte: number) => boolean): [number, number] {
    const s = this.newState();
    const a = this.newState();
    this.states[s].byteEdges.push({ test, target: a });
    return [s, a];
  }
}

class StreamingMatcher implements CompiledMatcher {
  private current: Set<number>;
  private byteCount = 0;
  private isMatched = false;

  constructor(
    private readonly states: State[],
    private readonly start: number,
  ) {
    this.current = this.closure(new Set([start]), true, false);
    this.checkAccept();
  }

  get matched(): boolean {
    return this.isMatched;
  }

  advance(byte: number): void {
    if (this.isMatched) return;
    const next = new Set<number>();
    for (const id of this.current) {
      for (const edge of this.states[id].byteEdges) {
        if (edge.test(byte)) next.add(edge.target);
      }
    }
    // Unanchored search: a new match attempt may start at every position.
    next.add(this.start);
    this.byteCount++;
    this.current = this.closure(next, false, false);
    this.checkAccept();
  }

  finish(): boolean {
    if (!this.isMatched) {
      // At end of body, '$' holds; '^' additionally holds if the body is empty.
      this.current = this.closure(this.current, this.byteCount === 0, true);
      this.checkAccept();
    }
    return this.isMatched;
  }

  private checkAccept(): void {
    for (const id of this.current) {
      if (this.states[id].accepting) {
        this.isMatched = true;
        return;
      }
    }
  }

  private closure(seed: Set<number>, allowStart: boolean, allowEnd: boolean): Set<number> {
    const result = new Set<number>();
    const stack = [...seed];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (result.has(id)) continue;
      result.add(id);
      const state = this.states[id];
      for (const t of state.epsEdges) stack.push(t);
      if (allowStart) for (const t of state.startAnchorEdges) stack.push(t);
      if (allowEnd) for (const t of state.endAnchorEdges) stack.push(t);
    }
    return result;
  }
}

/** Compile an AST into a streaming matcher. */
export function compileMatcher(ast: AstNode): CompiledMatcher {
  const builder = new NfaBuilder();
  const [start, accept] = builder.build(ast);
  builder.states[accept].accepting = true;
  return new StreamingMatcher(builder.states, start);
}
