import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints } from "../src/index.js";
import type { CapitalTable } from "../src/index.js";

const base: CapitalTable = {
  commonShares: "100",
  preferred: [{ id: "P", shares: "10", liquidation: "50", participating: false }],
};

test("rejects invalid tables and exit values", () => {
  assert.throws(() => allocate({ commonShares: "0", preferred: [] }, "1"), /commonShares/);
  assert.throws(() => allocate(base, "-1"), /exitValue/);
  assert.throws(() => allocate(base, "1.5"), /exitValue/);
  assert.throws(() => allocate({ ...base, preferred: [{ id: "P", shares: "0", liquidation: "50", participating: false }] }, "1"), /shares/);
  assert.throws(() => allocate({ ...base, preferred: [{ id: "P", shares: "10", liquidation: "0", participating: false }] }, "1"), /liquidation/);
  assert.throws(() => allocate({ ...base, preferred: [{ id: "P", shares: "10", liquidation: "50", participating: false, cap: "60" }] }, "1"), /cap/);
  assert.throws(() => allocate({ ...base, preferred: [{ id: "P", shares: "10", liquidation: "50", participating: true, cap: "40" }] }, "1"), /cap/);
  assert.throws(
    () => allocate({ ...base, preferred: [
      { id: "P", shares: "10", liquidation: "50", participating: false },
      { id: "P", shares: "5", liquidation: "5", participating: false },
    ] }, "1"),
    /duplicate/,
  );
});

test("empty preferred: common takes everything, no breakpoints", () => {
  const table: CapitalTable = { commonShares: "7", preferred: [] };
  assert.deepEqual(breakpoints(table), []);
  const result = allocate(table, "1000000");
  assert.equal(result.common.num, 1000000n);
  assert.equal(result.common.den, 1n);
  assert.deepEqual(result.preferred, []);
});

test("zero exit value: everyone gets exactly zero", () => {
  const result = allocate(base, "0");
  assert.equal(result.common.num, 0n);
  assert.equal(result.preferred[0]!.amount.num, 0n);
  assert.equal(result.preferred[0]!.converted, false);
});

test("accepts number and bigint inputs as well as strings", () => {
  const result = allocate({ commonShares: 100, preferred: [{ id: "P", shares: 10n, liquidation: "50", participating: false }] }, 60n);
  assert.equal(result.common.num * 1n, 10n);
  assert.equal(result.preferred[0]!.amount.num, 50n);
});
