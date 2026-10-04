import type { Rational } from "./rational.js";
import * as R from "./rational.js";
import * as P from "./polynomial.js";

/** One raw cashflow record: month offset 0..24, signed amount in cents.
 *  Positive = borrower receives funds, negative = payment/fee. */
export interface Cashflow {
  readonly month: number;
  readonly cents: bigint | number;
}

/** One APR candidate: a closed interval containing exactly one distinct real
 *  root of the NPV equation, plus that root's multiplicity. */
export interface Candidate {
  readonly lower: Rational;
  readonly upper: Rational;
  readonly multiplicity: number;
}

export type AnalysisResult =
  | { readonly kind: "none" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "finite"; readonly candidates: readonly Candidate[] };

const MAX_MONTH = 24;

// Roots of V(a) = sum C[m] / (1 + a/12)^m for a in [0, 6] are the roots of
// the polynomial F(t) = sum C[m] * t^(24-m) for t in [1, 3/2], with
// t = 1 + a/12, i.e. a = 12 * (t - 1). Multiplicities are preserved.
const T_LO = R.rationalFromBigInt(1n);
const T_HI = R.makeRational(3n, 2n);
const TWO = R.rationalFromBigInt(2n);
const TWELVE = R.rationalFromBigInt(12n);
// Isolation width in t so that the mapped a-interval is at most 1e-10 wide.
const EPS_T = R.makeRational(1n, 120_000_000_000n);

interface RootInterval {
  lo: Rational;
  hi: Rational;
}

function isExact(interval: RootInterval): boolean {
  return R.cmp(interval.lo, interval.hi) === 0;
}

function midpoint(lo: Rational, hi: Rational): Rational {
  return R.div(R.add(lo, hi), TWO);
}

function mergeCashflows(cashflows: readonly Cashflow[]): bigint[] {
  const monthly: bigint[] = new Array<bigint>(MAX_MONTH + 1).fill(0n);
  for (const cf of cashflows) {
    if (!Number.isInteger(cf.month) || cf.month < 0 || cf.month > MAX_MONTH) {
      throw new Error(`invalid month: ${String(cf.month)}`);
    }
    let cents: bigint;
    if (typeof cf.cents === "bigint") {
      cents = cf.cents;
    } else if (typeof cf.cents === "number" && Number.isSafeInteger(cf.cents)) {
      cents = BigInt(cf.cents);
    } else {
      throw new Error(`invalid cents: ${String(cf.cents)}`);
    }
    monthly[cf.month] += cents;
  }
  return monthly;
}

/**
 * Merge cashflows into monthly amounts, build the exact NPV polynomial and
 * enumerate every distinct real root of V(a) = sum C[m] / (1 + a/12)^m
 * in the closed interval a in [0, 6].
 */
export function analyze(cashflows: readonly Cashflow[]): AnalysisResult {
  const monthly = mergeCashflows(cashflows);
  if (monthly.every((c) => c === 0n)) {
    return { kind: "indeterminate" };
  }

  const coeffs: bigint[] = new Array<bigint>(MAX_MONTH + 1);
  for (let m = 0; m <= MAX_MONTH; m++) {
    coeffs[MAX_MONTH - m] = monthly[m];
  }
  const poly = P.fromBigIntCoeffs(coeffs);

  const factors = P.squareFreeFactorization(poly);
  let sqfree = P.fromBigIntCoeffs([1n]);
  for (const f of factors) {
    sqfree = P.mul(sqfree, f.factor);
  }
  const sturm = P.sturmSequence(sqfree);

  const countOpen = (lo: Rational, hi: Rational): number =>
    P.countRootsOpenInterval(sturm, sqfree, lo, hi);

  // Refine an interval known to contain exactly one root of sqfree strictly
  // inside until its width is at most eps. Returns a zero-width interval
  // when the root is a dyadic rational hit exactly.
  const refine = (lo0: Rational, hi0: Rational, eps: Rational): RootInterval => {
    let lo = lo0;
    let hi = hi0;
    while (R.cmp(R.sub(hi, lo), eps) > 0) {
      const mid = midpoint(lo, hi);
      if (R.isZero(P.evaluate(sqfree, mid))) {
        return { lo: mid, hi: mid };
      }
      if (countOpen(lo, mid) >= 1) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return { lo, hi };
  };

  const isolate = (lo: Rational, hi: Rational): RootInterval[] => {
    const n = countOpen(lo, hi);
    if (n === 0) {
      return [];
    }
    if (n === 1) {
      return [refine(lo, hi, EPS_T)];
    }
    const mid = midpoint(lo, hi);
    if (R.isZero(P.evaluate(sqfree, mid))) {
      return [...isolate(lo, mid), { lo: mid, hi: mid }, ...isolate(mid, hi)];
    }
    return [...isolate(lo, mid), ...isolate(mid, hi)];
  };

  const roots: RootInterval[] = [];
  if (R.isZero(P.evaluate(sqfree, T_LO))) {
    roots.push({ lo: T_LO, hi: T_LO });
  }
  if (R.isZero(P.evaluate(sqfree, T_HI))) {
    roots.push({ lo: T_HI, hi: T_HI });
  }
  roots.push(...isolate(T_LO, T_HI));

  roots.sort((a, b) => R.cmp(a.lo, b.lo));

  // Distinct roots can sit closer together than the target width; shrink
  // intervals further until every consecutive pair is strictly disjoint.
  let i = 0;
  while (i < roots.length - 1) {
    const a = roots[i];
    const b = roots[i + 1];
    if (R.cmp(a.hi, b.lo) >= 0) {
      if (!isExact(a)) {
        roots[i] = refine(a.lo, a.hi, R.div(R.sub(a.hi, a.lo), TWO));
      }
      if (!isExact(b)) {
        roots[i + 1] = refine(b.lo, b.hi, R.div(R.sub(b.hi, b.lo), TWO));
      }
    } else {
      i++;
    }
  }

  const factorSturms = factors.map((f) => P.sturmSequence(f.factor));
  const multiplicityOf = (root: RootInterval): number => {
    if (isExact(root)) {
      for (const f of factors) {
        if (R.isZero(P.evaluate(f.factor, root.lo))) {
          return f.multiplicity;
        }
      }
    } else {
      for (let k = 0; k < factors.length; k++) {
        const count = P.countRootsOpenInterval(
          factorSturms[k],
          factors[k].factor,
          root.lo,
          root.hi,
        );
        if (count === 1) {
          return factors[k].multiplicity;
        }
      }
    }
    throw new Error("internal error: root not matched to any square-free factor");
  };

  const candidates: Candidate[] = roots.map((root) => ({
    lower: R.mul(R.sub(root.lo, T_LO), TWELVE),
    upper: R.mul(R.sub(root.hi, T_LO), TWELVE),
    multiplicity: multiplicityOf(root),
  }));

  if (candidates.length === 0) {
    return { kind: "none" };
  }
  return { kind: "finite", candidates };
}

/** Exact NPV at a rational APR: sum C[m] / (1 + apr/12)^m. */
export function npv(cashflows: readonly Cashflow[], apr: Rational): Rational {
  const monthly = mergeCashflows(cashflows);
  const base = R.add(R.rationalFromBigInt(1n), R.div(apr, TWELVE));
  const inv = R.div(R.rationalFromBigInt(1n), base);
  let sum = R.rationalFromBigInt(0n);
  let power = R.rationalFromBigInt(1n);
  for (let m = 0; m <= MAX_MONTH; m++) {
    sum = R.add(sum, R.mul(R.rationalFromBigInt(monthly[m]), power));
    power = R.mul(power, inv);
  }
  return sum;
}
