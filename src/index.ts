import { parsePattern } from "./parser.js";
import { compileNfa, type CompiledNfa } from "./nfa.js";
import { RuleMatcher } from "./matcher.js";

export interface SignatureRule {
  id: string;
  pattern: string;
}

interface CompiledRule {
  id: string;
  nfa: CompiledNfa;
}

/** In-memory rule set. Add rules, then create independent detections. */
export class SignatureRuleSet {
  private readonly rules: CompiledRule[] = [];
  private readonly ids = new Set<string>();

  /** Add a rule. Throws on duplicate id or invalid pattern. */
  addRule(rule: SignatureRule): void {
    if (this.ids.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    const nfa = compileNfa(parsePattern(rule.pattern));
    this.ids.add(rule.id);
    this.rules.push({ id: rule.id, nfa });
  }

  /** Start a new independent body inspection over the current rules. */
  createDetection(): BodyDetection {
    return new BodyDetection(
      this.rules.map((rule) => ({ id: rule.id, matcher: new RuleMatcher(rule.nfa) })),
    );
  }
}

/** One streaming inspection of a single request body. */
export class BodyDetection {
  private ended = false;

  constructor(private readonly matchers: Array<{ id: string; matcher: RuleMatcher }>) {}

  /** Submit the next decoded byte chunk. Empty chunks are no-ops. */
  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error("cannot push after end()");
    for (const { matcher } of this.matchers) matcher.push(chunk);
  }

  /** Declare body end; returns ids of all matched rules (each once). */
  end(): string[] {
    if (this.ended) throw new Error("end() called twice");
    this.ended = true;
    const hits: string[] = [];
    for (const { id, matcher } of this.matchers) {
      if (matcher.end()) hits.push(id);
    }
    return hits;
  }
}
