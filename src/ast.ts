/** Pattern AST node kinds. */
export type AstNode =
  | { kind: "empty" }
  | { kind: "literal"; byte: number }
  | { kind: "anyByte" }
  | { kind: "class"; negated: boolean; ranges: ReadonlyArray<readonly [number, number]> }
  | { kind: "concat"; parts: AstNode[] }
  | { kind: "alt"; branches: AstNode[] }
  | { kind: "repeat"; node: AstNode; min: number; max: number | null }
  | { kind: "anchorStart" }
  | { kind: "anchorEnd" };
