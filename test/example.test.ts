import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints, rationalToString } from "../src/index.js";
import type { CapitalTable } from "../src/index.js";

// Common 100 shares; P1 participating with cap 200, L 100, s 100;
// P2 non-participating, L 100, s 100.
const table: CapitalTable = {
  commonShares: "100",
  preferred: [
    { id: "P1", shares: "100", liquidation: "100", participating: true, cap: "200" },
    { id: "P2", shares: "100", liquidation: "100", participating: false },
  ],
};

function amounts(exitValue: string | number): { common: string; p1: string; p2: string; p1c: boolean; p2c: boolean } {
  const result = allocate(table, exitValue);
  const p1 = result.preferred.find((p) => p.id === "P1")!;
  const p2 = result.preferred.find((p) => p.id === "P2")!;
  return {
    common: rationalToString(result.common),
    p1: rationalToString(p1.amount),
    p2: rationalToString(p2.amount),
    p1c: p1.converted,
    p2c: p2.converted,
  };
}

test("breakpoints are exactly 200, 400, 600", () => {
  assert.deepEqual(breakpoints(table).map(rationalToString), ["200", "400", "600"]);
});

test("pro-rata regime at and below sum(L) = 200", () => {
  assert.deepEqual(amounts(100), { common: "0", p1: "50", p2: "50", p1c: false, p2c: false });
  assert.deepEqual(amounts(200), { common: "0", p1: "100", p2: "100", p1c: false, p2c: false });
});

test("between 200 and 400: P1 participates below cap, P2 keeps preference", () => {
  assert.deepEqual(amounts(201), { common: "1/2", p1: "201/2", p2: "100", p1c: false, p2c: false });
  assert.deepEqual(amounts(399), { common: "199/2", p1: "399/2", p2: "100", p1c: false, p2c: false });
});

test("at 400: P1 hits cap and P2 ties on conversion; both keep preferred identity", () => {
  assert.deepEqual(amounts(400), { common: "100", p1: "200", p2: "100", p1c: false, p2c: false });
});

test("between 400 and 600: P1 capped, P2 converted", () => {
  assert.deepEqual(amounts(401), { common: "201/2", p1: "200", p2: "201/2", p1c: false, p2c: true });
  assert.deepEqual(amounts(599), { common: "399/2", p1: "200", p2: "399/2", p1c: false, p2c: true });
});

test("at 600: P1 ties on conversion at its cap and stays preferred", () => {
  assert.deepEqual(amounts(600), { common: "200", p1: "200", p2: "200", p1c: false, p2c: true });
});

test("above 600: everyone converted, paid per share", () => {
  assert.deepEqual(amounts(601), { common: "601/3", p1: "601/3", p2: "601/3", p1c: true, p2c: true });
});

test("at 900 each of the three classes gets exactly 300", () => {
  assert.deepEqual(amounts(900), { common: "300", p1: "300", p2: "300", p1c: true, p2c: true });
});
