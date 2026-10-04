import { Rational } from "./rational";
import {
  Poly,
  constPoly,
  degree,
  evaluatePoly,
  isZeroPoly,
  mulPoly,
  squareFreeFactors,
} from "./polynomial";
import { Interval, isolateRoots, signVariations, sturmSequence } from "./sturm";

export const MIN_MONTH = 0;
export const MAX_MONTH = 24;
/** APR search range: [0, 6] as a nominal annual rate (1 = 100%). */
export const MIN_APR = 0;
export const MAX_APR = 6;
/** Maximum width of a reported candidate interval: 1e-10. */
export const WIDTH_LIMIT = Rational.of(1n, 10_000_000_000n);

export interface CashflowRecord {
  month: number;
  cents: bigint | number;
}

export interface AprCandidate {
  /** Closed interval bounds within [0, 6]; lower === upper for exact roots. */
  lower: Rational;
  upper: Rational;
  /** Order of the zero of V at this rate. */
  multiplicity: number;
}

export type AnalysisResult =
  | { kind: "none" }
  | { kind: "indeterminate" }
  | { kind: "finite"; candidates: AprCandidate[] };

/** Merges records into monthly net cashflows C[0..24] as bigints. */
function aggregate(records: CashflowRecord[]): bigint[] {
  const months: bigint[] = new Array(MAX_MONTH + 1).fill(0n);
  for (const rec of records) {
    if (!Number.isInteger(rec.month) || rec.month < MIN_MONTH || rec.month > MAX_MONTH) {
      throw new Error(`month must be an integer in [${MIN_MONTH}, ${MAX_MONTH}], got ${rec.month}`);
    }
    let cents: bigint;
    if (typeof rec.cents === "bigint") {
      cents = rec.cents;
    } else if (typeof rec.cents === "number" && Number.isInteger(rec.cents)) {
      cents = BigInt(rec.cents);
    } else {
      throw new Error(`cents must be an integer, got ${rec.cents}`);
    }
    months[rec.month] = months[rec.month]! + cents;
  }
  return months;
}

/**
 * V(a) = sum C[m] / (1 + a/12)^m = x^-24 * P(x) with x = 1 + a/12 and
 * P(x) = sum C[m] * x^(24-m). Roots of V in [0, 6] are roots of P in [1, 3/2]
 * with identical multiplicities, since x^-24 > 0 and dx/da = 1/12 != 0.
 */
function toPolynomial(months: bigint[]): Poly {
  const p: Poly = new Array(MAX_MONTH + 1);
  for (let k = 0; k <= MAX_MONTH; k++) {
    p[k] = Rational.of(months[MAX_MONTH - k]!);
  }
  while (p.length > 0 && p[p.length - 1]!.isZero()) p.pop();
  return p;
}

const X_LO = Rational.one();
const X_HI = Rational.of(3n, 2n);
const TWELVE = Rational.of(12n);
const MAX_WIDTH_X = WIDTH_LIMIT.div(TWELVE);

function toApr(x: Rational): Rational {
  return x.sub(X_LO).mul(TWELVE);
}

export function analyze(records: CashflowRecord[]): AnalysisResult {
  const months = aggregate(records);
  const p = toPolynomial(months);
  if (isZeroPoly(p)) return { kind: "indeterminate" };

  const factors = squareFreeFactors(p); // factors[i] holds roots of multiplicity i+1
  let kernel = constPoly(Rational.one());
  for (const q of factors) {
    if (degree(q) > 0) kernel = mulPoly(kernel, q);
  }

  const intervals: Interval[] =
    degree(kernel) > 0 ? isolateRoots(kernel, X_LO, X_HI, MAX_WIDTH_X) : [];
  if (intervals.length === 0) return { kind: "none" };

  // Assign each isolated root its multiplicity: the root lies in exactly one
  // square-free factor Q_i, detectable via Q_i's Sturm count on the interval.
  const factorSturms = factors.map((q) => sturmSequence(q));
  const multiplicityOf = (iv: Interval): number => {
    for (let i = 0; i < factors.length; i++) {
      const q = factors[i]!;
      if (degree(q) <= 0) continue;
      if (iv.lower.equals(iv.upper)) {
        if (evaluatePoly(q, iv.lower).isZero()) return i + 1;
      } else {
        const count =
          signVariations(factorSturms[i]!, iv.lower) -
          signVariations(factorSturms[i]!, iv.upper);
        if (count > 0) return i + 1;
      }
    }
    throw new Error("internal: isolated root not found in any square-free factor");
  };

  const candidates: AprCandidate[] = intervals.map((iv) => ({
    lower: toApr(iv.lower),
    upper: toApr(iv.upper),
    multiplicity: multiplicityOf(iv),
  }));
  candidates.sort((a, b) => a.lower.compare(b.lower));
  return { kind: "finite", candidates };
}

/** Exact net present value V(a) = sum C[m] / (1 + a/12)^m. */
export function npv(records: CashflowRecord[], apr: Rational): Rational {
  const months = aggregate(records);
  const base = Rational.one().add(apr.div(TWELVE));
  if (base.isZero()) throw new Error("apr must be greater than -12");
  let sum = Rational.zero();
  let power = Rational.one(); // base^m
  for (let m = 0; m <= MAX_MONTH; m++) {
    const c = months[m]!;
    if (c !== 0n) sum = sum.add(Rational.of(c).div(power));
    power = power.mul(base);
  }
  return sum;
}
