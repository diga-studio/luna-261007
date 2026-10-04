import { Rational } from "./rational";
import {
  Poly,
  derivativePoly,
  divmodPoly,
  evaluatePoly,
  isZeroPoly,
  scalePoly,
} from "./polynomial";

/** Sturm sequence of a square-free polynomial f: s0 = f, s1 = f', s_{k+1} = -rem(s_{k-1}, s_k). */
export function sturmSequence(f: Poly): Poly[] {
  const seq: Poly[] = [f];
  if (f.length <= 1) return seq;
  seq.push(derivativePoly(f));
  while (true) {
    const prev = seq[seq.length - 2]!;
    const cur = seq[seq.length - 1]!;
    if (isZeroPoly(cur)) break;
    const [, rem] = divmodPoly(prev, cur);
    const next = scalePoly(rem, Rational.of(-1n));
    if (isZeroPoly(next)) break;
    seq.push(next);
  }
  return seq;
}

/** Number of sign variations of the Sturm sequence evaluated at x (zero values skipped). */
export function signVariations(seq: Poly[], x: Rational): number {
  let count = 0;
  let prevSign = 0;
  for (const poly of seq) {
    const s = evaluatePoly(poly, x).sign();
    if (s === 0) continue;
    if (prevSign !== 0 && s !== prevSign) count++;
    prevSign = s;
  }
  return count;
}

export interface Interval {
  lower: Rational;
  upper: Rational;
}

const TWO = Rational.of(2n);

/**
 * Isolates every distinct real root of the square-free polynomial f in the closed
 * interval [lo, hi]. Returns pairwise disjoint closed intervals (zero-width when the
 * root is hit exactly by a bisection node or interval endpoint), each of width
 * <= maxWidth and containing exactly one root, sorted ascending.
 */
export function isolateRoots(
  f: Poly,
  lo: Rational,
  hi: Rational,
  maxWidth: Rational,
): Interval[] {
  if (f.length <= 1) return [];
  const seq = sturmSequence(f);
  const at = (x: Rational) => evaluatePoly(f, x);
  const variations = (x: Rational) => signVariations(seq, x);

  const results: Interval[] = [];
  if (at(lo).isZero()) results.push({ lower: lo, upper: lo });
  if (at(hi).isZero()) results.push({ lower: hi, upper: hi });

  // Roots in (l, r] = V(l) - V(r); roots in the open interval (l, r) exclude a root at r.
  const rootsInOpen = (l: Rational, r: Rational): number => {
    let c = variations(l) - variations(r);
    if (at(r).isZero()) c -= 1;
    return c;
  };

  const bisect = (l: Rational, r: Rational): void => {
    const count = rootsInOpen(l, r);
    if (count === 0) return;
    if (
      count === 1 &&
      !at(l).isZero() &&
      !at(r).isZero() &&
      r.sub(l).compare(maxWidth) <= 0
    ) {
      results.push({ lower: l, upper: r });
      return;
    }
    const m = l.add(r).div(TWO);
    if (at(m).isZero()) results.push({ lower: m, upper: m });
    bisect(l, m);
    bisect(m, r);
  };
  bisect(lo, hi);

  results.sort((a, b) => a.lower.compare(b.lower));

  // Emitted intervals come from disjoint open bisection cells, but adjacent cells may
  // share an endpoint. Refine any touching pair until all intervals are disjoint.
  const refine = (iv: Interval): void => {
    if (iv.lower.equals(iv.upper)) return;
    const m = iv.lower.add(iv.upper).div(TWO);
    if (at(m).isZero()) {
      iv.lower = m;
      iv.upper = m;
      return;
    }
    if (rootsInOpen(iv.lower, m) === 1) {
      iv.upper = m;
    } else {
      iv.lower = m;
    }
  };
  let touching = true;
  while (touching) {
    touching = false;
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!;
      const cur = results[i]!;
      if (prev.upper.compare(cur.lower) >= 0) {
        refine(prev);
        refine(cur);
        touching = true;
      }
    }
  }
  return results;
}
