import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { analyze, npv } from "../src/apr.js";
import type { Cashflow } from "../src/apr.js";
import type { Rational } from "../src/rational.js";
import {
  parseRational,
  rationalFromBigInt,
  makeRational,
  add,
  mul,
  div,
  cmp,
  isZero,
  sign,
} from "../src/rational.js";
import { checkCandidatesWellFormed, contains, serialize } from "./helpers.js";

// Independent construction of the test polynomial over BigInt:
//   R(t) = (t-1)(2t-3)(t-2)^15 (4t-5)^2 (t^2-2)^2 (t-3),  degree 24.
// Roots in t = 1 + a/12:
//   t = 1    -> a = 0          (range endpoint, multiplicity 1)
//   t = 3/2  -> a = 6          (range endpoint, multiplicity 1)
//   t = 5/4  -> a = 3          (interior, multiplicity 2)
//   t = sqrt(2) -> a = 12(sqrt(2)-1) ~= 4.97  (interior irrational, multiplicity 2)
//   t = 2    -> a = 12         (OUT of range, multiplicity 15)
//   t = 3    -> a = 24         (OUT of range, multiplicity 1)
function mulBig(p: bigint[], q: bigint[]): bigint[] {
  const out = new Array<bigint>(p.length + q.length - 1).fill(0n);
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      out[i + j] += p[i] * q[j];
    }
  }
  return out;
}

function powBig(p: bigint[], n: number): bigint[] {
  let r = [1n];
  for (let i = 0; i < n; i++) {
    r = mulBig(r, p);
  }
  return r;
}

function buildPoly(): bigint[] {
  let r = [1n];
  const factors: bigint[][] = [
    [-1n, 1n], // (t-1)
    [-3n, 2n], // (2t-3)
    powBig([-2n, 1n], 15), // (t-2)^15
    powBig([-5n, 4n], 2), // (4t-5)^2
    powBig([-2n, 0n, 1n], 2), // (t^2-2)^2
    [-3n, 1n], // (t-3)
  ];
  for (const f of factors) {
    r = mulBig(r, f);
  }
  return r;
}

// R(t) = sum C[m] t^(24-m), so C[m] is the coefficient of t^(24-m).
const POLY = buildPoly(); // POLY[i] = coefficient of t^i
const DEGREE = POLY.length - 1;

const CASHFLOWS: Cashflow[] = POLY.map((c, i) => ({
  month: DEGREE - i,
  cents: c,
}));

test("constructed degree-24 cashflow respects the input bounds", () => {
  equal(DEGREE, 24);
  const limit = 10n ** 12n;
  for (const c of POLY) {
    ok(c <= limit && c >= -limit, "merged monthly amount exceeds 1e12 cents");
  }
});

test("endpoint roots, out-of-range roots and multiple roots are all handled", () => {
  const result = analyze(CASHFLOWS);
  equal(result.kind, "finite");
  if (result.kind !== "finite") return;

  equal(result.candidates.length, 4, "exactly the four in-range roots must be reported");
  checkCandidatesWellFormed(result.candidates);

  const [c0, c1, c2, c3] = result.candidates;

  // a = 0: exact endpoint root, zero-width interval, multiplicity 1.
  equal(c0.multiplicity, 1);
  ok(isZero(c0.lower) && isZero(c0.upper), "endpoint root at 0 must be exact");

  // a = 3: interior double root (dyadic in t, isolated exactly or tightly).
  equal(c1.multiplicity, 2);
  ok(contains(c1, "3"), "interval must contain 3");

  // a = 12*(sqrt(2)-1): irrational double root. Verify containment exactly by
  // squaring the mapped t-interval: (1 + a/12)^2 must bracket 2.
  equal(c2.multiplicity, 2);
  const twelve = rationalFromBigInt(12n);
  const one = rationalFromBigInt(1n);
  const two = rationalFromBigInt(2n);
  const tLo = add(one, div(c2.lower, twelve));
  const tHi = add(one, div(c2.upper, twelve));
  ok(cmp(mul(tLo, tLo), two) < 0, "lower bound above sqrt(2)");
  ok(cmp(mul(tHi, tHi), two) > 0, "upper bound below sqrt(2)");

  // a = 6: exact endpoint root, zero-width interval, multiplicity 1.
  equal(c3.multiplicity, 1);
  ok(cmp(c3.lower, parseRational("6")) === 0, "endpoint root at 6 must be exact");
  ok(cmp(c3.upper, parseRational("6")) === 0, "endpoint root at 6 must be exact");

  // Exact NPV checks: in-range roots vanish, and the out-of-range roots
  // a = 12 and a = 24 really are roots of the same NPV equation (so the
  // construction itself is validated), yet are not reported.
  ok(isZero(npv(CASHFLOWS, parseRational("0"))));
  ok(isZero(npv(CASHFLOWS, parseRational("3"))));
  ok(isZero(npv(CASHFLOWS, parseRational("6"))));
  ok(isZero(npv(CASHFLOWS, parseRational("12"))));
  ok(isZero(npv(CASHFLOWS, parseRational("24"))));

  // Double roots keep the NPV sign on both sides.
  const left3 = sign(npv(CASHFLOWS, parseRational("2.999999")));
  const right3 = sign(npv(CASHFLOWS, parseRational("3.000001")));
  ok(left3 !== 0 && left3 === right3, "sign must not change across the double root at 3");
  const leftS = sign(npv(CASHFLOWS, parseRational("4.9705")));
  const rightS = sign(npv(CASHFLOWS, parseRational("4.9706")));
  ok(leftS !== 0 && leftS === rightS, "sign must not change across the double root at 12*(sqrt(2)-1)");
});

test("shuffled, split and canceled records give identical candidates", () => {
  const shuffled = [...CASHFLOWS].reverse();
  const splitAndCanceled: Cashflow[] = [];
  for (const cf of CASHFLOWS) {
    const cents = cf.cents as bigint;
    const half = cents / 2n;
    splitAndCanceled.push({ month: cf.month, cents: half });
    splitAndCanceled.push({ month: cf.month, cents: cents - half });
  }
  splitAndCanceled.push({ month: 7, cents: 999999999999n });
  splitAndCanceled.push({ month: 7, cents: -999999999999n });

  const expected = serialize(analyze(CASHFLOWS));
  equal(serialize(analyze(shuffled)), expected);
  equal(serialize(analyze(splitAndCanceled)), expected);
});
