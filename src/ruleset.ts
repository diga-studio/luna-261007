import { parsePattern } from './parser';
import { compileMatcher, type CompiledMatcher } from './nfa';

export interface Rule {
  readonly id: string;
  readonly pattern: string;
}

/** A single body inspection: feed chunks, then finish to get hit rule ids. */
export interface Inspection {
  /** Submit a decoded body chunk. Empty chunks are allowed and change nothing. */
  submit(chunk: Uint8Array): void;
  /** Declare the body complete. Returns the set of hit rule ids (each once). */
  end(): Set<string>;
}

interface CompiledRule {
  readonly id: string;
  readonly ast: ReturnType<typeof parsePattern>;
}

/** In-memory rule set; creates independent inspections. */
export class RuleSet {
  private readonly rules: CompiledRule[] = [];
  private readonly ids = new Set<string>();

  /** Add a rule with a unique id and a pattern. Returns this for chaining. */
  addRule(id: string, pattern: string): this {
    if (this.ids.has(id)) {
      throw new Error(`duplicate rule id: ${id}`);
    }
    const ast = parsePattern(pattern);
    this.ids.add(id);
    this.rules.push({ id, ast });
    return this;
  }

  /** Number of rules in this set. */
  get size(): number {
    return this.rules.length;
  }

  /** Create a new independent inspection over the current rules. */
  createInspection(): Inspection {
    return new StreamingInspection(
      this.rules.map((rule) => ({ id: rule.id, matcher: compileMatcher(rule.ast) })),
    );
  }
}

/** Internal: per-inspection streaming state. */
export class StreamingInspection implements Inspection {
  private ended = false;
  private hits: Set<string> | null = null;

  constructor(
    private readonly matchers: Array<{ id: string; matcher: CompiledMatcher }>,
  ) {}

  submit(chunk: Uint8Array): void {
    if (this.ended) {
      throw new Error('inspection already ended');
    }
    for (const { matcher } of this.matchers) {
      if (matcher.matched) continue;
      for (let i = 0; i < chunk.length; i++) {
        matcher.advance(chunk[i]);
      }
    }
  }

  end(): Set<string> {
    if (this.hits !== null) {
      return new Set(this.hits);
    }
    this.ended = true;
    const hits = new Set<string>();
    for (const { id, matcher } of this.matchers) {
      if (matcher.finish()) hits.add(id);
    }
    this.hits = hits;
    return new Set(hits);
  }
}
