import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints, rationalToString, addR } from "./helpers.js";
import type { CapitalTable, PreferredClassInput } from "../src/index.js";
import { referenceAllocate, referenceBreakpoints } from "./reference.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTable(rand: () => number, classes: number): CapitalTable {
  const big = () => BigInt(1 + Math.floor(rand() * 50));
  const huge = () => BigInt("9007199254740993") + BigInt(Math.floor(rand() * 1e6));
  const pick = () => (rand() < 0.3 ? huge() : big());
  const preferred: PreferredClassInput[] = [];
  for (let i = 0; i < classes; i += 1) {
    const shares = pick();
    const liquidation = pick();
    const kind = rand();
    if (kind < 0.34) {
      preferred.push({ id: `P${i}`, shares, liquidation, participating: false });
    } else if (kind < 0.67) {
      preferred.push({ id: `P${i}`, shares, liquidation, participating: true });
    } else {
      const extra = rand() < 0.25 ? 0n : BigInt(Math.floor(rand() * 3)) * liquidation + big();
      preferred.push({ id: `P${i}`, shares, liquidation, participating: true, cap: liquidation + extra });
    }
  }
  return { commonShares: pick(), preferred };
}

function totalPreferenceOf(table: CapitalTable): bigint {
  return table.preferred.reduce((sum, p) => sum + BigInt(p.liquidation), 0n);
}

test("random small tables match the slow reference, class by class", () => {
  const rand = mulberry32(20261005);
  for (let trial = 0; trial < 300; trial += 1) {
    const classes = 1 + Math.floor(rand() * 8);
    const table = randomTable(rand, classes);
    const sumL = totalPreferenceOf(table);
    const candidates = [
      0n,
      1n,
      sumL > 0n ? sumL - 1n : 0n,
      sumL,
      sumL + 1n,
      BigInt(Math.floor(rand() * Number(sumL > 0n ? 4n * sumL : 100n))),
      sumL * 3n + BigInt(Math.floor(rand() * 1000)),
    ];
    for (const v of candidates) {
      const fast = allocate(table, v);
      const slow = referenceAllocate(table, v);
      assert.equal(rationalToString(fast.common), rationalToString(slow.common), `common at V=${v}, trial=${trial}`);
      assert.equal(fast.preferred.length, slow.preferred.length);
      for (let i = 0; i < fast.preferred.length; i += 1) {
        const f = fast.preferred[i]!;
        const s = slow.preferred[i]!;
        assert.equal(f.id, s.id);
        assert.equal(rationalToString(f.amount), rationalToString(s.amount), `class ${f.id} at V=${v}, trial=${trial}`);
        assert.equal(f.converted, s.converted, `converted flag of ${f.id} at V=${v}, trial=${trial}`);
      }
      // Exact conservation.
      let total = fast.common;
      for (const p of fast.preferred) {
        total = addR(total, p.amount);
      }
      assert.equal(rationalToString(total), v.toString(), `conservation at V=${v}, trial=${trial}`);
    }
  }
});

test("random small table breakpoints match the slow reference", () => {
  const rand = mulberry32(97531);
  for (let trial = 0; trial < 200; trial += 1) {
    const classes = 1 + Math.floor(rand() * 8);
    const table = randomTable(rand, classes);
    const fast = breakpoints(table).map(rationalToString);
    const slow = referenceBreakpoints(table).map(rationalToString);
    assert.deepEqual(fast, slow, `breakpoints mismatch at trial=${trial}`);
  }
});

test("50k-class table: full curve and allocations stay exact and fast", () => {
  const n = 50000;
  const preferred: PreferredClassInput[] = [];
  for (let i = 0; i < n; i += 1) {
    const shares = BigInt(1 + (i % 97)) * 1000000n;
    const liquidation = BigInt(1 + (i % 89)) * 1000000007n;
    const kind = i % 3;
    if (kind === 0) {
      preferred.push({ id: `P${i}`, shares, liquidation, participating: false });
    } else if (kind === 1) {
      preferred.push({ id: `P${i}`, shares, liquidation, participating: true });
    } else {
      const cap = i % 7 === 0 ? liquidation : liquidation * 2n + BigInt(i % 13);
      preferred.push({ id: `P${i}`, shares, liquidation, participating: true, cap });
    }
  }
  const table: CapitalTable = { commonShares: "123456789", preferred };

  const t0 = Date.now();
  const bps = breakpoints(table);
  const t1 = Date.now();
  assert.ok(bps.length >= 1 && bps.length <= 1 + 2 * n);
  for (let i = 1; i < bps.length; i += 1) {
    const prev = bps[i - 1]!;
    const curr = bps[i]!;
    assert.ok(prev.num * curr.den < curr.num * prev.den, "breakpoints strictly increasing");
  }

  const sumL = totalPreferenceOf(table);
  for (const v of [0n, sumL / 2n, sumL, sumL + 1n, sumL * 5n, sumL * 1000000n]) {
    const result = allocate(table, v);
    let total = result.common;
    for (const p of result.preferred) {
      total = addR(total, p.amount);
    }
    assert.equal(rationalToString(total), v.toString(), `conservation at V=${v}`);
  }
  const t2 = Date.now();
  console.log(`50k classes: ${bps.length} breakpoints in ${t1 - t0}ms, 6 allocations + checks in ${t2 - t1}ms`);
  assert.ok(t2 - t0 < 30000, "must stay well within O(n log n) territory");
});
