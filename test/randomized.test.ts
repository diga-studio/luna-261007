import test from "node:test";
import assert from "node:assert/strict";
import { allocate, breakpoints } from "../src/index";
import type { CapitalTableInput, Rational } from "../src/index";
import { referenceAllocate } from "./reference";

// Deterministic PRNG (mulberry32) so failures are reproducible.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTable(rand: () => number, index: number): CapitalTableInput {
  const n = 1 + Math.floor(rand() * 6);
  const preferred = [];
  for (let i = 0; i < n; i += 1) {
    const shares = 1n + BigInt(Math.floor(rand() * 20));
    const preference = 1n + BigInt(Math.floor(rand() * 200));
    const participating = rand() < 0.6;
    const cap = participating && rand() < 0.7
      ? preference + BigInt(Math.floor(rand() * 100))
      : undefined;
    preferred.push({
      id: `t${index}p${i}`,
      shares: shares.toString(),
      preference: preference.toString(),
      participating,
      ...(cap !== undefined ? { cap: cap.toString() } : {}),
    });
  }
  return {
    common: { id: `t${index}c`, shares: (1n + BigInt(Math.floor(rand() * 20))).toString() },
    preferred,
  };
}

function candidateValues(
  table: CapitalTableInput,
  rand: () => number,
): bigint[] {
  const sumL = table.preferred.reduce((acc, c) => acc + BigInt(c.preference as string), 0n);
  const values = new Set<bigint>();
  values.add(0n);
  values.add(1n);
  values.add(sumL - 1n);
  values.add(sumL);
  values.add(sumL + 1n);
  values.add(sumL * 1000000n + 12345n);
  for (let i = 0; i < 6; i += 1) {
    values.add(BigInt(Math.floor(rand() * Number(sumL) * 5)));
  }
  // Probe around every reported breakpoint (floor and ceil, both sides).
  for (const bp of breakpoints(table)) {
    const floor = bp.num / bp.den;
    const ceil = bp.num % bp.den === 0n ? floor : floor + 1n;
    for (const v of [floor - 1n, floor, ceil, ceil + 1n]) {
      if (v >= 0n) values.add(v);
    }
  }
  return [...values];
}

function eq(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

test("random small tables match the slow reference class by class", () => {
  const rand = prng(20261005);
  for (let t = 0; t < 25; t += 1) {
    const table = randomTable(rand, t);
    for (const v of candidateValues(table, rand)) {
      const fast = allocate(table, v.toString());
      const slow = referenceAllocate(table, v);
      assert.ok(eq(fast.common.amount, slow.common.amount), `common at table ${t} V=${v}`);
      assert.equal(fast.preferred.length, slow.preferred.length);
      let sumNum = fast.common.amount.num;
      let sumDen = fast.common.amount.den;
      for (let i = 0; i < fast.preferred.length; i += 1) {
        const f = fast.preferred[i]!;
        const s = slow.preferred[i]!;
        assert.equal(f.id, s.id);
        assert.ok(eq(f.amount, s.amount), `${f.id} amount at table ${t} V=${v}`);
        assert.equal(f.converted, s.converted, `${f.id} converted at table ${t} V=${v}`);
        sumNum = sumNum * f.amount.den + f.amount.num * sumDen;
        sumDen *= f.amount.den;
      }
      assert.equal(sumNum, v * sumDen, `conservation at table ${t} V=${v}`);
    }
  }
});
