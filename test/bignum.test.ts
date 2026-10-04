import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints, rational, rationalToString, addR } from "./helpers.js";
import type { CapitalTable } from "../src/index.js";

const E18 = 10n ** 18n;

// Two non-participating classes whose conversion rates 1/1e18 and 1/(1e18-1)
// are extremely close but distinct rationals. All magnitudes exceed 2^53.
const table: CapitalTable = {
  commonShares: "1",
  preferred: [
    { id: "A", shares: E18.toString(), liquidation: "1", participating: false },
    { id: "B", shares: (E18 - 1n).toString(), liquidation: "1", participating: false },
  ],
};

test("close but distinct rational breakpoints are not merged", () => {
  const bps = breakpoints(table);
  // sum(L) = 2, then the two conversion valuations.
  assert.equal(bps.length, 3);
  assert.equal(rationalToString(bps[0]!), "2");
  // V1 = 2 + 1/1e18 (common is the only per-share class before either event).
  assert.equal(rationalToString(bps[1]!), `${2n * E18 + 1n}/${E18}`);
  // V2 = 1 + (1e18+1)/(1e18-1): after A converts, slope = 1 + 1e18, constant = 1.
  const v2num = (E18 + 1n) + (E18 - 1n);
  const v2den = E18 - 1n;
  assert.equal(rationalToString(bps[2]!), `${v2num}/${v2den}`);
  // Strictly increasing, nothing merged.
  for (let i = 1; i < bps.length; i += 1) {
    const prev = bps[i - 1]!;
    const curr = bps[i]!;
    assert.ok(prev.num * curr.den < curr.num * prev.den);
  }
});

test("pro-rata below sum(L) with huge denominators stays exact", () => {
  const result = allocate(table, "1");
  assert.equal(rationalToString(result.common), "0");
  assert.equal(rationalToString(result.preferred[0]!.amount), "1/2");
  assert.equal(rationalToString(result.preferred[1]!.amount), "1/2");
  assert.ok(!result.preferred[0]!.converted && !result.preferred[1]!.converted);
});

test("exact conservation with amounts beyond 2^53", () => {
  const bigTable: CapitalTable = {
    commonShares: (E18 + 3n).toString(),
    preferred: [
      { id: "X", shares: (E18 - 7n).toString(), liquidation: (E18 + 11n).toString(), participating: true, cap: (2n * E18).toString() },
      { id: "Y", shares: (E18 + 13n).toString(), liquidation: (E18 - 5n).toString(), participating: false },
      { id: "Z", shares: (E18 + 1n).toString(), liquidation: (E18 + 2n).toString(), participating: true },
    ],
  };
  for (const v of ["1", "3000000000000000000", "3000000000000000001", "9007199254740993", "12345678901234567890123456789"]) {
    const result = allocate(bigTable, v);
    let total = result.common;
    for (const p of result.preferred) {
      total = addR(total, p.amount);
    }
    assert.equal(rationalToString(total), v, `conservation at V=${v}`);
    // Amounts are reduced rationals.
    for (const p of result.preferred) {
      assert.deepEqual(p.amount, rational(p.amount.num, p.amount.den));
    }
  }
});

test("both classes convert at V=3 with exact per-share rate 3/(2e18)", () => {
  const at3 = allocate(table, "3");
  assert.equal(at3.preferred[0]!.converted, true);
  assert.equal(at3.preferred[1]!.converted, true);
  assert.equal(rationalToString(at3.common), `3/${2n * E18}`);
  assert.equal(rationalToString(at3.preferred[0]!.amount), "3/2");
  assert.equal(rationalToString(at3.preferred[1]!.amount), `${3n * (E18 - 1n)}/${2n * E18}`);
});

test("conversion tie keeps preferred identity, one cent above converts", () => {
  const tieTable: CapitalTable = {
    commonShares: "1",
    preferred: [
      { id: "A", shares: "1", liquidation: E18.toString(), participating: false },
    ],
  };
  // r = 1e18 exactly at V = 2e18: s*r == L, tie -> stays preferred.
  const tie = allocate(tieTable, (2n * E18).toString());
  assert.equal(tie.preferred[0]!.converted, false);
  assert.equal(rationalToString(tie.preferred[0]!.amount), E18.toString());
  assert.equal(rationalToString(tie.common), E18.toString());
  // V = 2e18 + 1: r = (2e18+1)/2 > 1e18 -> converts.
  const above = allocate(tieTable, (2n * E18 + 1n).toString());
  assert.equal(above.preferred[0]!.converted, true);
  assert.equal(rationalToString(above.preferred[0]!.amount), `${2n * E18 + 1n}/2`);
  assert.equal(rationalToString(above.common), `${2n * E18 + 1n}/2`);
});
