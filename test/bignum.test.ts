import test from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints } from "../src/index";
import type { CapitalTableInput, Rational } from "../src/index";

// Amounts and share counts beyond 2^53. Two non-participating classes whose
// conversion thresholds straddle r=1 from opposite sides at distance ~1e-18:
//   tB = 1e18/(1e18+1) < 1 < (1e18+1)/1e18 = tA
const E18 = 10n ** 18n;
const table: CapitalTableInput = {
  common: { id: "common", shares: "1" },
  preferred: [
    { id: "A", shares: E18.toString(), preference: (E18 + 1n).toString(), participating: false },
    { id: "B", shares: (E18 + 1n).toString(), preference: E18.toString(), participating: false },
  ],
};

const SUM_L = 2n * E18 + 1n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function expectReduced(q: Rational) {
  assert.equal(gcd(q.num, q.den), 1n, `${q.num}/${q.den} not reduced`);
  assert.ok(q.den > 0n);
}

function expectEq(q: Rational, num: bigint, den: bigint, what: string) {
  assert.equal(q.num * den, num * q.den, `${what}: ${q.num}/${q.den} != ${num}/${den}`);
  expectReduced(q);
}

test("close rational breakpoints beyond 2^53 are not merged", () => {
  const bps = breakpoints(table);
  assert.equal(bps.length, 3);
  // 1: aggregate preference.
  expectEq(bps[0]!, SUM_L, 1n, "bp0");
  // 2: P(tB) = SUM_L + tB (common is the only slope before tB).
  expectEq(bps[1]!, SUM_L * (E18 + 1n) + E18, E18 + 1n, "bp1");
  // 3: P(tA) = 2*(1e18+1)^2 / 1e18.
  expectEq(bps[2]!, 2n * (E18 + 1n) * (E18 + 1n), E18, "bp2");
  // The last two differ by only ~2 cents out of ~2e18 but stay distinct.
  const [x, y] = [bps[1]!, bps[2]!];
  assert.notEqual(x.num * y.den, y.num * x.den);
  const diffNum = y.num * x.den - x.num * y.den;
  const diffDen = x.den * y.den;
  assert.ok(diffNum > 0n && diffNum < diffDen * 4n, "gap too large");
});

test("pro-rata sharing under insufficient funds is exact and conserved", () => {
  const v = E18; // < SUM_L
  const res = allocate(table, v.toString());
  assert.deepEqual(res.common.amount, { num: 0n, den: 1n });
  const a = res.preferred.find((p) => p.id === "A")!;
  const b = res.preferred.find((p) => p.id === "B")!;
  assert.equal(a.converted, false);
  assert.equal(b.converted, false);
  expectEq(a.amount, v * (E18 + 1n), SUM_L, "A pro-rata");
  expectEq(b.amount, v * E18, SUM_L, "B pro-rata");
  // Exact conservation of the (indivisible) total.
  const sumNum = a.amount.num * b.amount.den + b.amount.num * a.amount.den;
  const sumDen = a.amount.den * b.amount.den;
  assert.equal(sumNum, v * sumDen);
});

test("razor-thin threshold gap: at V=2e18+3 exactly r=1 splits the classes", () => {
  const v = 2n * E18 + 3n;
  const res = allocate(table, v.toString());
  const a = res.preferred.find((p) => p.id === "A")!;
  const b = res.preferred.find((p) => p.id === "B")!;
  assert.deepEqual(res.common.amount, { num: 1n, den: 1n });
  // r=1 < tA so A keeps its preference; r=1 > tB so B converts.
  assert.equal(a.converted, false);
  assert.equal(b.converted, true);
  assert.deepEqual(a.amount, { num: E18 + 1n, den: 1n });
  assert.deepEqual(b.amount, { num: E18 + 1n, den: 1n });
});

test("huge exit value conserves exactly with all classes converted", () => {
  const v = 123456789012345678901234567890n;
  const res = allocate(table, v.toString());
  const a = res.preferred.find((p) => p.id === "A")!;
  const b = res.preferred.find((p) => p.id === "B")!;
  assert.equal(a.converted, true);
  assert.equal(b.converted, true);
  const totalShares = 1n + E18 + (E18 + 1n);
  expectEq(res.common.amount, v * 1n, totalShares, "common");
  expectEq(a.amount, v * E18, totalShares, "A");
  expectEq(b.amount, v * (E18 + 1n), totalShares, "B");
  const parts = [res.common.amount, a.amount, b.amount];
  let sumNum = 0n;
  let sumDen = 1n;
  for (const q of parts) {
    sumNum = sumNum * q.den + q.num * sumDen;
    sumDen *= q.den;
  }
  assert.equal(sumNum, v * sumDen, "exact conservation");
});
