import test from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints } from "../src/index";

test("no preferred classes: everything goes to common", () => {
  const table = { common: { id: "c", shares: "10" }, preferred: [] };
  assert.deepEqual(breakpoints(table), []);
  const res = allocate(table, "0");
  assert.deepEqual(res.common.amount, { num: 0n, den: 1n });
  const res2 = allocate(table, 10n ** 18n);
  assert.deepEqual(res2.common.amount, { num: 10n ** 18n, den: 1n });
  assert.equal(res2.preferred.length, 0);
});

test("zero exit value: everyone gets exactly zero", () => {
  const table = {
    common: { id: "c", shares: "5" },
    preferred: [
      { id: "p", shares: "3", preference: "100", participating: true, cap: "150" },
    ],
  };
  const res = allocate(table, "0");
  assert.deepEqual(res.common.amount, { num: 0n, den: 1n });
  assert.deepEqual(res.preferred[0]!.amount, { num: 0n, den: 1n });
  assert.equal(res.preferred[0]!.converted, false);
});

test("uncapped participating class never converts", () => {
  const table = {
    common: { id: "c", shares: "1" },
    preferred: [
      { id: "p", shares: "1000000", preference: "1", participating: true },
    ],
  };
  const res = allocate(table, (10n ** 24n).toString());
  assert.equal(res.preferred[0]!.converted, false);
  // L + s*r with r = (V - 1) / (1 + 1000000), returned fully reduced.
  const num = 10n ** 24n - 1n;
  const den = 1000001n;
  const g = gcd(num, den);
  assert.deepEqual(res.common.amount, { num: num / g, den: den / g });
});

test("cap equal to preference: only aggregate and conversion breakpoints", () => {
  const table = {
    common: { id: "c", shares: "1" },
    preferred: [
      { id: "p", shares: "2", preference: "10", participating: true, cap: "10" },
    ],
  };
  assert.deepEqual(breakpoints(table), [
    { num: 10n, den: 1n },
    { num: 15n, den: 1n },
  ]);
  const res = allocate(table, "15");
  assert.equal(res.preferred[0]!.converted, false);
  assert.deepEqual(res.preferred[0]!.amount, { num: 10n, den: 1n });
});

test("bigint inputs are accepted directly", () => {
  const table = {
    common: { id: "c", shares: 100n },
    preferred: [
      { id: "p", shares: 100n, preference: 100n, participating: false },
    ],
  };
  const res = allocate(table, 250n);
  assert.deepEqual(res.common.amount, { num: 125n, den: 1n });
  assert.deepEqual(res.preferred[0]!.amount, { num: 125n, den: 1n });
  assert.equal(res.preferred[0]!.converted, true);
});

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

test("invalid inputs are rejected", () => {
  const base = {
    common: { id: "c", shares: "1" },
    preferred: [
      { id: "p", shares: "1", preference: "10", participating: false },
    ],
  };
  assert.throws(() => allocate(base, "-1"));
  assert.throws(() => allocate(base, "1.5"));
  assert.throws(() =>
    allocate({ common: { id: "c", shares: "0" }, preferred: [] }, "1"),
  );
  assert.throws(() =>
    allocate(
      {
        common: { id: "c", shares: "1" },
        preferred: [
          { id: "p", shares: "1", preference: "10", participating: true, cap: "5" },
        ],
      },
      "1",
    ),
  );
  assert.throws(() =>
    allocate(
      {
        common: { id: "c", shares: "1" },
        preferred: [
          { id: "p", shares: "1", preference: "10", participating: false, cap: "10" },
        ],
      },
      "1",
    ),
  );
  assert.throws(() =>
    allocate(
      {
        common: { id: "c", shares: "1" },
        preferred: [
          { id: "p", shares: "1", preference: "10", participating: false },
          { id: "p", shares: "1", preference: "10", participating: false },
        ],
      },
      "1",
    ),
  );
});
