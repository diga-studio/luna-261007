import type { AstNode } from "./ast.js";

const HEX = /^[0-9a-fA-F]$/;

class PatternParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): AstNode {
    const node = this.parseAlt();
    if (this.pos < this.src.length) {
      throw this.error(`unexpected '${this.src[this.pos]}'`);
    }
    return node;
  }

  private error(msg: string): SyntaxError {
    return new SyntaxError(`invalid pattern at offset ${this.pos}: ${msg}`);
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private next(): string {
    if (this.pos >= this.src.length) throw this.error("unexpected end of pattern");
    return this.src[this.pos++];
  }

  private parseAlt(): AstNode {
    const branches: AstNode[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.pos++;
      branches.push(this.parseConcat());
    }
    return branches.length === 1 ? branches[0] : { kind: "alt", branches };
  }

  private parseConcat(): AstNode {
    const parts: AstNode[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === undefined || ch === "|" || ch === ")") break;
      parts.push(this.parseRepeat());
    }
    if (parts.length === 0) return { kind: "empty" };
    return parts.length === 1 ? parts[0] : { kind: "concat", parts };
  }

  private parseRepeat(): AstNode {
    const atom = this.parseAtom();
    const ch = this.peek();
    if (ch === "*" || ch === "+" || ch === "?") {
      this.pos++;
      const node: AstNode =
        ch === "*"
          ? { kind: "repeat", node: atom, min: 0, max: null }
          : ch === "+"
            ? { kind: "repeat", node: atom, min: 1, max: null }
            : { kind: "repeat", node: atom, min: 0, max: 1 };
      const after = this.peek();
      if (after === "*" || after === "+" || after === "?") {
        throw this.error("stacked quantifiers are not allowed");
      }
      return node;
    }
    return atom;
  }

  private parseAtom(): AstNode {
    const ch = this.next();
    switch (ch) {
      case "(": {
        const inner = this.parseAlt();
        if (this.next() !== ")") throw this.error("expected ')'");
        return inner;
      }
      case ")":
        throw this.error("unmatched ')'");
      case "[":
        return this.parseClass();
      case ".":
        return { kind: "anyByte" };
      case "^":
        return { kind: "anchorStart" };
      case "$":
        return { kind: "anchorEnd" };
      case "\\":
        return { kind: "literal", byte: this.parseEscape() };
      case "*":
      case "+":
      case "?":
        throw this.error(`'${ch}' has nothing to repeat`);
      case "|":
        throw this.error("unexpected '|'");
      default: {
        const code = ch.charCodeAt(0);
        if (code > 0xff) throw this.error("non-byte character in pattern");
        return { kind: "literal", byte: code };
      }
    }
  }

  /** Parse an escape sequence after a backslash. Returns the byte value. */
  private parseEscape(): number {
    const ch = this.next();
    switch (ch) {
      case "n":
        return 0x0a;
      case "r":
        return 0x0d;
      case "t":
        return 0x09;
      case "f":
        return 0x0c;
      case "v":
        return 0x0b;
      case "0":
        return 0x00;
      case "x": {
        const hi = this.next();
        const lo = this.next();
        if (!HEX.test(hi) || !HEX.test(lo)) {
          throw this.error("expected two hex digits after \\x");
        }
        return parseInt(hi + lo, 16);
      }
      default: {
        const code = ch.charCodeAt(0);
        // Metacharacters (and the backslash itself) escape to themselves.
        if (code <= 0x7f && !/[A-Za-z0-9]/.test(ch)) {
          return code;
        }
        throw this.error(`unsupported escape '\\${ch}'`);
      }
    }
  }

  private parseClass(): AstNode {
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.pos++;
    }
    const ranges: Array<readonly [number, number]> = [];
    let first = true;
    for (;;) {
      if (this.pos >= this.src.length) throw this.error("unterminated character class");
      if (this.peek() === "]" && !first) {
        this.pos++;
        break;
      }
      first = false;
      const loByte = this.parseClassItem();
      if (this.peek() === "-" && this.src[this.pos + 1] !== "]" && this.pos + 1 < this.src.length) {
        this.pos++;
        const hiByte = this.parseClassItem();
        if (hiByte < loByte) throw this.error("class range end before start");
        ranges.push([loByte, hiByte]);
      } else {
        ranges.push([loByte, loByte]);
      }
    }
    return { kind: "class", negated, ranges };
  }

  /** Parse one item inside a character class; returns its byte value. */
  private parseClassItem(): number {
    const ch = this.next();
    if (ch === "\\") return this.parseEscape();
    const code = ch.charCodeAt(0);
    if (code > 0xff) throw this.error("non-byte character in class");
    return code;
  }
}

/** Parse a pattern string into an AST. Throws SyntaxError on invalid patterns. */
export function parsePattern(pattern: string): AstNode {
  return new PatternParser(pattern).parse();
}
