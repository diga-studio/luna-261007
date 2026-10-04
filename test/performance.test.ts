import test from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints } from "../src/index";
import type { CapitalTableInput, PreferredClassInput, Rational } from "../src/index";

const N = 50_000;

function bigTable(): CapitalTableInput {
  const preferred: PreferredClassInput[] = [];
  for (let i = 0; i < N; i += 1) {
    const shares = BigInt((i % 97) + 1) * 10n ** 12n + BigInt(i);
    const preference = BigInt(i + 1) * 10n ** 15n + 7n;
    const kind = i % 3;
    if (kind === 0) {
      preferred.push({
        id: `np${i}`,
        shares: shares.toString(),
        preference: preference.toString(),
        participating: false,
      });
    } else if (kind === 1) {
      preferred.push({
        id: `pu${i}`,
        shares: shares.toString(),
        preference: preference.toString(),
        participating: true,
      });
    } else {
      preferred.push({
        id: `pc${i}`,
        shares: shares.toString(),
        preference: preference.toString(),
        participating: true,
        cap: (preference + BigInt(i + 1) * 10n ** 14n).toString(),
      });
    }
  }
  return {
    common: { id: "common", shares: (10n ** 18n).toString() },
    preferred,
  };
}

function cmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

test("50k classes: full breakpoint curve in one pass", () => {
  const table = bigTable();
  const start = Date.now();
  const bps = breakpoints(table);
  const elapsed = Date.now() - start;
  // One point for the aggregate preference plus one per distinct event
  // threshold (conversion for non-participating; cap-then-conversion for
  // capped participating). Equal thresholds collapse to a single value.
  const thresholds = new Set<string>();
  for (const cls of table.preferred) {
    const s = BigInt(cls.shares as string);
    const l = BigInt(cls.preference as string);
    const key = (num: bigint, den: bigint) => {
      const g = gcd(num, den);
      return `${num / g}/${den / g}`;
    };
    if (!cls.participating) {
      thresholds.add(key(l, s));
    } else if (cls.cap !== undefined) {
      const c = BigInt(cls.cap as string);
      thresholds.add(key(c - l, s));
      thresholds.add(key(c, s));
    }
  }
  thresholds.delete("0/1");
  const expected = 1 + thresholds.size;
  assert.equal(bps.length, expected);
  for (let i = 1; i < bps.length; i += 1) {
    assert.ok(cmp(bps[i - 1]!, bps[i]!) < 0, `not strictly ascending at ${i}`);
  }
  assert.ok(elapsed < 10_000, `breakpoints took ${elapsed}ms`);
});

test("50k classes: allocations conserve exactly", () => {
  const table = bigTable();
  const bps = breakpoints(table);
  const probes: bigint[] = [0n, 1n];
  for (const idx of [0, bps.length >> 1, bps.length - 1]) {
    const bp = bps[idx]!;
    const floor = bp.num / bp.den;
    probes.push(floor > 0n ? floor - 1n : 0n, floor, floor + 1n);
  }
  probes.push(10n ** 30n);
  const start = Date.now();
  for (const v of probes) {
    const res = allocate(table, v.toString());
    let sumNum = res.common.amount.num;
    let sumDen = res.common.amount.den;
    for (const p of res.preferred) {
      sumNum = sumNum * p.amount.den + p.amount.num * sumDen;
      sumDen *= p.amount.den;
      const g = gcd(sumNum < 0n ? -sumNum : sumNum, sumDen);
      sumNum /= g;
      sumDen /= g;
    }
    assert.equal(sumNum, v * sumDen, `conservation at ${v}`);
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10_000, `allocations took ${elapsed}ms`);
});

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}
