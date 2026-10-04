import type { AstNode } from "./ast.js";

/** A single NFA state. Transitions are stored on the state itself. */
export interface NfaState {
  /** Byte-consuming transitions: [lo, hi, target]. */
  byteEdges: Array<readonly [number, number, NfaState]>;
  /** Epsilon transitions (always allowed). */
  epsEdges: NfaState[];
  /** Zero-width assertion: only passes at absolute body start. */
  startAssertEdges: NfaState[];
  /** Zero-width assertion: only passes at absolute body end. */
  endAssertEdges: NfaState[];
}

export interface CompiledNfa {
  start: NfaState;
  accept: NfaState;
}

function newState(): NfaState {
  return { byteEdges: [], epsEdges: [], startAssertEdges: [], endAssertEdges: [] };
}

interface Fragment {
  start: NfaState;
  accept: NfaState;
}

function compileNode(node: AstNode): Fragment {
  switch (node.kind) {
    case "empty": {
      const start = newState();
      const accept = newState();
      start.epsEdges.push(accept);
      return { start, accept };
    }
    case "literal": {
      const start = newState();
      const accept = newState();
      start.byteEdges.push([node.byte, node.byte, accept]);
      return { start, accept };
    }
    case "anyByte": {
      const start = newState();
      const accept = newState();
      start.byteEdges.push([0, 255, accept]);
      return { start, accept };
    }
    case "class": {
      const start = newState();
      const accept = newState();
      if (node.negated) {
        // Complement the ranges over the full byte domain 0..255.
        let cursor = 0;
        const sorted = [...node.ranges].sort((a, b) => a[0] - b[0]);
        for (const [lo, hi] of sorted) {
          if (lo > cursor) start.byteEdges.push([cursor, lo - 1, accept]);
          cursor = Math.max(cursor, hi + 1);
        }
        if (cursor <= 255) start.byteEdges.push([cursor, 255, accept]);
      } else {
        for (const [lo, hi] of node.ranges) start.byteEdges.push([lo, hi, accept]);
      }
      return { start, accept };
    }
    case "concat": {
      let frag = compileNode(node.parts[0]);
      for (let i = 1; i < node.parts.length; i++) {
        const nextFrag = compileNode(node.parts[i]);
        frag.accept.epsEdges.push(nextFrag.start);
        frag = { start: frag.start, accept: nextFrag.accept };
      }
      return frag;
    }
    case "alt": {
      const start = newState();
      const accept = newState();
      for (const branch of node.branches) {
        const frag = compileNode(branch);
        start.epsEdges.push(frag.start);
        frag.accept.epsEdges.push(accept);
      }
      return { start, accept };
    }
    case "repeat": {
      return compileRepeat(node.node, node.min, node.max);
    }
    case "anchorStart": {
      const start = newState();
      const accept = newState();
      start.startAssertEdges.push(accept);
      return { start, accept };
    }
    case "anchorEnd": {
      const start = newState();
      const accept = newState();
      start.endAssertEdges.push(accept);
      return { start, accept };
    }
  }
}

function compileRepeat(inner: AstNode, min: number, max: number | null): Fragment {
  // Fixed mandatory copies.
  let frag: Fragment | null = null;
  for (let i = 0; i < min; i++) {
    const copy = compileNode(inner);
    if (frag === null) {
      frag = copy;
    } else {
      frag.accept.epsEdges.push(copy.start);
      frag = { start: frag.start, accept: copy.accept };
    }
  }

  if (max === null) {
    // Star tail: a state that can enter the loop body or skip past it.
    const loop = newState();
    const body = compileNode(inner);
    loop.epsEdges.push(body.start);
    body.accept.epsEdges.push(loop);
    if (frag === null) {
      // Pure star: loop state is both entry and exit.
      return { start: loop, accept: loop };
    }
    frag.accept.epsEdges.push(loop);
    return { start: frag.start, accept: loop };
  }

  // Finite optional copies: each may be skipped.
  const accept = newState();
  let tailEntry: NfaState;
  if (frag === null) {
    const start = newState();
    start.epsEdges.push(accept);
    frag = { start, accept };
    tailEntry = start;
  } else {
    tailEntry = frag.accept;
    tailEntry.epsEdges.push(accept);
  }
  for (let i = min; i < max; i++) {
    const copy = compileNode(inner);
    tailEntry.epsEdges.push(copy.start);
    copy.accept.epsEdges.push(accept);
    tailEntry = copy.accept;
  }
  return { start: frag.start, accept };
}

/** Compile an AST into an NFA. */
export function compileNfa(ast: AstNode): CompiledNfa {
  const frag = compileNode(ast);
  return { start: frag.start, accept: frag.accept };
}
