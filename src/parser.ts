/** Pattern AST nodes. */
export type AstNode =
  | { kind: 'empty' }
  | { kind: 'literal'; byte: number }
  | { kind: 'dot' }
  | { kind: 'class'; negated: boolean; ranges: ReadonlyArray<readonly [number, number]> }
  | { kind: 'concat'; parts: AstNode[] }
  | { kind: 'alt'; branches: AstNode[] }
  | { kind: 'repeat'; node: AstNode; min: number; max: number | null }
  | { kind: 'startAnchor' }
  | { kind: 'endAnchor' };

export class PatternSyntaxError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
    this.name = 'PatternSyntaxError';
  }
}

const QUANTIFIERS = new Set(['*', '+', '?']);

class Parser {
  private pos = 0;

  constructor(private readonly pattern: string) {}

  parse(): AstNode {
    const node = this.parseAlternation();
    if (this.pos !== this.pattern.length) {
      throw this.error(`unexpected '${this.peek()}'`);
    }
    return node;
  }

  private peek(): string | undefined {
    return this.pattern[this.pos];
  }

  private next(): string {
    return this.pattern[this.pos++];
  }

  private error(message: string): PatternSyntaxError {
    return new PatternSyntaxError(`${message} at offset ${this.pos}`, this.pos);
  }

  private parseAlternation(): AstNode {
    const branches: AstNode[] = [this.parseConcat()];
    while (this.peek() === '|') {
      this.pos++;
      branches.push(this.parseConcat());
    }
    return branches.length === 1 ? branches[0] : { kind: 'alt', branches };
  }

  private parseConcat(): AstNode {
    const parts: AstNode[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === undefined || ch === '|' || ch === ')') break;
      parts.push(this.parseRepeat());
    }
    if (parts.length === 0) return { kind: 'empty' };
    return parts.length === 1 ? parts[0] : { kind: 'concat', parts };
  }

  private parseRepeat(): AstNode {
    const atom = this.parseAtom();
    const ch = this.peek();
    if (ch !== undefined && QUANTIFIERS.has(ch)) {
      this.pos++;
      const node: AstNode =
        ch === '*'
          ? { kind: 'repeat', node: atom, min: 0, max: null }
          : ch === '+'
            ? { kind: 'repeat', node: atom, min: 1, max: null }
            : { kind: 'repeat', node: atom, min: 0, max: 1 };
      if (this.peek() !== undefined && QUANTIFIERS.has(this.peek()!)) {
        throw this.error(`double quantifier '${this.peek()}'`);
      }
      return node;
    }
    return atom;
  }

  private parseAtom(): AstNode {
    const ch = this.next();
    switch (ch) {
      case '.':
        return { kind: 'dot' };
      case '^':
        return { kind: 'startAnchor' };
      case '$':
        return { kind: 'endAnchor' };
      case '(': {
        const inner = this.parseAlternation();
        if (this.peek() !== ')') throw this.error("expected ')'");
        this.pos++;
        return inner;
      }
      case ')':
        throw this.error("unmatched ')'");
      case '[':
        return this.parseClass();
      case '\\':
        return { kind: 'literal', byte: this.parseEscape() };
      case '*':
      case '+':
      case '?':
        throw this.error(`quantifier '${ch}' without an atom`);
      default: {
        const code = ch.codePointAt(0)!;
        if (code > 0xff) {
          throw this.error('non-ASCII literal; use \\xHH escapes for bytes > 0x7F');
        }
        return { kind: 'literal', byte: code };
      }
    }
  }

  /** Parses an escape sequence after the backslash. Returns a byte value. */
  private parseEscape(): number {
    const ch = this.next();
    if (ch === undefined) throw this.error('trailing backslash');
    if (ch === 'x') {
      const hex = this.pattern.slice(this.pos, this.pos + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw this.error('invalid \\xHH escape');
      }
      this.pos += 2;
      return parseInt(hex, 16);
    }
    const code = ch.codePointAt(0)!;
    if (code > 0xff) {
      throw this.error('non-ASCII escape; use \\xHH escapes for bytes > 0x7F');
    }
    return code;
  }

  /** Parses a character class; the leading '[' is already consumed. */
  private parseClass(): AstNode {
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.pos++;
    }
    const ranges: Array<readonly [number, number]> = [];
    let first = true;
    for (;;) {
      const ch = this.peek();
      if (ch === undefined) throw this.error('unterminated character class');
      if (ch === ']' && !first) {
        this.pos++;
        break;
      }
      first = false;
      const lo = this.parseClassItem();
      if (this.peek() === '-' && this.pattern[this.pos + 1] !== ']' && this.pattern[this.pos + 1] !== undefined) {
        this.pos++;
        const hi = this.parseClassItem();
        if (hi < lo) throw this.error('class range start exceeds end');
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    if (ranges.length === 0) throw this.error('empty character class');
    return { kind: 'class', negated, ranges };
  }

  /** Parses one class member (literal byte or escape). */
  private parseClassItem(): number {
    const ch = this.next();
    if (ch === '\\') return this.parseEscape();
    const code = ch.codePointAt(0)!;
    if (code > 0xff) {
      throw this.error('non-ASCII character in class; use \\xHH escapes');
    }
    return code;
  }
}

/** Parse a pattern string into an AST. Throws PatternSyntaxError on invalid input. */
export function parsePattern(pattern: string): AstNode {
  return new Parser(pattern).parse();
}
