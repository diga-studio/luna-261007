import { ok } from "node:assert/strict";
import type { Candidate } from "../src/apr.js";
import { parseRational, cmp, sub } from "../src/rational.js";

export const MAX_WIDTH = parseRational("0.0000000001"); // 1e-10

export function checkCandidatesWellFormed(candidates: readonly Candidate[]): void {
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    ok(cmp(c.lower, parseRational("0")) >= 0, `candidate ${i} below 0`);
    ok(cmp(c.upper, parseRational("6")) <= 0, `candidate ${i} above 6`);
    ok(cmp(c.lower, c.upper) <= 0, `candidate ${i} inverted`);
    ok(cmp(sub(c.upper, c.lower), MAX_WIDTH) <= 0, `candidate ${i} too wide`);
    if (i > 0) {
      ok(
        cmp(candidates[i - 1].upper, c.lower) < 0,
        `candidates ${i - 1}, ${i} not disjoint/ordered`,
      );
    }
  }
}

export function contains(c: Candidate, apr: string): boolean {
  const a = parseRational(apr);
  return cmp(c.lower, a) <= 0 && cmp(a, c.upper) <= 0;
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v));
}
