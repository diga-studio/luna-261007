import test from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints } from "../src/index";
import type { CapitalTableInput, Rational } from "../src/index";

// Common s=100; P1 participating L=100 C=200 s=100; P2 non-participating
// L=100 s=100. Critical values must be exactly 200, 400, 600.
const table: CapitalTableInput = {
  common: { id: "common", shares: "100" },
  preferred: [
    { id: "p1", shares: "100", preference: "100", participating: true, cap: "200" },
    { id: "p2", shares: "100", preference: "100", participating: false },
  ],
};

function r(num: bigint, den: bigint = 1n): Rational {
  const g = (a: bigint, b: bigint): bigint => (b === 0n ? a : g(b, a % b));
  const d = g(num < 0n ? -num : num, den);
  return { num: num / d, den: den / d };
}

function amountsAt(v: string) {
  const res = allocate(table, v);
  const map = new Map<string, { amount: Rational; converted: boolean }>();
  map.set(res.common.id, { amount: res.common.amount, converted: res.common.converted });
  for (const p of res.preferred) {
    map.set(p.id, { amount: p.amount, converted: p.converted });
  }
  return map;
}

function check(
  v: string,
  expected: Record<string, { amount: Rational; converted: boolean }>,
) {
  const got = amountsAt(v);
  assert.deepEqual(got.get("common"), expected["common"]!, `common at ${v}`);
  assert.deepEqual(got.get("p1"), expected["p1"]!, `p1 at ${v}`);
  assert.deepEqual(got.get("p2"), expected["p2"]!, `p2 at ${v}`);
  // Exact conservation against the (integer) exit value.
  const sum = ["common", "p1", "p2"]
    .map((id) => got.get(id)!.amount)
    .reduce((acc, x) => ({ num: acc.num * x.den + x.num * acc.den, den: acc.den * x.den }));
  assert.equal(sum.num, BigInt(v) * sum.den, `conservation at ${v}`);
}

test("breakpoints are exactly 200, 400, 600", () => {
  assert.deepEqual(breakpoints(table), [r(200n), r(400n), r(600n)]);
});

test("pro-rata region at and below aggregate preference", () => {
  check("100", {
    common: { amount: r(0n), converted: false },
    p1: { amount: r(50n), converted: false },
    p2: { amount: r(50n), converted: false },
  });
  check("200", {
    common: { amount: r(0n), converted: false },
    p1: { amount: r(100n), converted: false },
    p2: { amount: r(100n), converted: false },
  });
});

test("between 200 and 400: p1 participates, p2 holds preference", () => {
  check("300", {
    common: { amount: r(50n), converted: false },
    p1: { amount: r(150n), converted: false },
    p2: { amount: r(100n), converted: false },
  });
});

test("at 400: p1 caps and p2 ties, both keep preferred status", () => {
  check("400", {
    common: { amount: r(100n), converted: false },
    p1: { amount: r(200n), converted: false },
    p2: { amount: r(100n), converted: false },
  });
});

test("between 400 and 600: p1 capped, p2 converted", () => {
  check("500", {
    common: { amount: r(150n), converted: false },
    p1: { amount: r(200n), converted: false },
    p2: { amount: r(150n), converted: true },
  });
});

test("at 600: p1 ties at cap and keeps preferred status", () => {
  check("600", {
    common: { amount: r(200n), converted: false },
    p1: { amount: r(200n), converted: false },
    p2: { amount: r(200n), converted: true },
  });
});

test("above 600: everything converted, 900 splits 300/300/300", () => {
  check("700", {
    common: { amount: r(700n, 3n), converted: false },
    p1: { amount: r(700n, 3n), converted: true },
    p2: { amount: r(700n, 3n), converted: true },
  });
  check("900", {
    common: { amount: r(300n), converted: false },
    p1: { amount: r(300n), converted: true },
    p2: { amount: r(300n), converted: true },
  });
});
