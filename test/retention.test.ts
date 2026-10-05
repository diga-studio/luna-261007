import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateRetention } from "../src/retention";
import type { RetentionBatchResult } from "../src/types";

/** 偏差总和（十分之一分）：Σ|10·累计扣留 − 累计金额| */
function totalDeviation(amounts: number[][], cumulative: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0; i < amounts.length; i++) {
    for (let t = 0; t < amounts[i]!.length; t++) {
      sum += Math.abs(10 * cumulative[i]![t]! - amounts[i]![t]!);
    }
  }
  return sum;
}

test("规格用例1：两分项两期，整批最优而非逐期最优", () => {
  // A: 4, 4  B: 2, 9
  const result = allocateRetention({ amounts: [[4, 4], [2, 9]] });
  assert.deepEqual(result.cumulative, [[0, 0], [1, 1]]);
  assert.deepEqual(result.current, [[0, 0], [1, 0]]);
  assert.equal(totalDeviation([[4, 4], [2, 9]], result.cumulative), 17);
});

test("规格用例2：单期并列取分项序靠前者为0，且结果可重复", () => {
  const first = allocateRetention({ amounts: [[5], [5]] });
  assert.deepEqual(first.cumulative, [[0], [1]]);
  assert.deepEqual(first.current, [[0], [1]]);
  const again = allocateRetention({ amounts: [[5], [5]] });
  assert.deepEqual(again, first);
});

test("金额恰为10%整数倍时保持精确值", () => {
  const result = allocateRetention({ amounts: [[10, 30], [20, 20]] });
  assert.deepEqual(result.cumulative, [[1, 3], [2, 2]]);
  assert.deepEqual(result.current, [[1, 2], [2, 0]]);
});

test("项目合计恰好半分时向上进一分", () => {
  // 单分项 15 分：round(1.5)=2
  const result = allocateRetention({ amounts: [[15]] });
  assert.deepEqual(result.cumulative, [[2]]);
  // 单分项 5 分：round(0.5)=1
  assert.deepEqual(allocateRetention({ amounts: [[5]] }).cumulative, [[1]]);
  // 单分项 4 分：round(0.4)=0
  assert.deepEqual(allocateRetention({ amounts: [[4]] }).cumulative, [[0]]);
});

test("首期期初累计扣留款为0，首期新增等于首期累计", () => {
  const result = allocateRetention({ amounts: [[13, 25], [7, 11]] });
  for (let i = 0; i < 2; i++) {
    assert.equal(result.current[i]![0], result.cumulative[i]![0]);
  }
});

test("输入校验：递减、非整数、负分、缺行均拒绝", () => {
  assert.throws(() => allocateRetention({ amounts: [[10, 5]] }), /non-decreasing/);
  assert.throws(() => allocateRetention({ amounts: [[1.5]] }), /non-negative integer/);
  assert.throws(() => allocateRetention({ amounts: [[-1]] }), /non-negative integer/);
  assert.throws(() => allocateRetention({ amounts: [[1], [1, 2]] }), /length/);
});

test("空批次返回空结果", () => {
  assert.deepEqual(allocateRetention({ amounts: [] }), { cumulative: [], current: [] });
});

// ---------- 暴力对拍 ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Cell { lo: number; hi: number; r: number }

/** 枚举全部完整方案，返回（偏差最小、字典序最小）的累计扣留矩阵。 */
function bruteForce(amounts: number[][]): number[][] {
  const n = amounts.length;
  const periods = amounts[0]!.length;
  const cells: Cell[][] = amounts.map((row) =>
    row.map((a) => {
      const lo = Math.floor(a / 10);
      return { lo, hi: lo + (a % 10 === 0 ? 0 : 1), r: a % 10 };
    }),
  );
  const target: number[] = [];
  for (let t = 0; t < periods; t++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += amounts[i]![t]!;
    target.push(Math.floor((sum + 5) / 10));
  }
  let best: number[][] | null = null;
  let bestDev = Infinity;
  const current: number[][] = cells.map((row) => row.map((c) => c.lo));
  const colSum = new Array<number>(periods).fill(0);
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < periods; t++) colSum[t]! += cells[i]![t]!.lo;
  }

  const lexSmaller = (a: number[][], b: number[][]): boolean => {
    for (let t = 0; t < periods; t++) {
      for (let i = 0; i < n; i++) {
        if (a[i]![t]! !== b[i]![t]!) return a[i]![t]! < b[i]![t]!;
      }
    }
    return false;
  };

  const consider = (): void => {
    let dev = 0;
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < periods; t++) {
        dev += Math.abs(10 * current[i]![t]! - amounts[i]![t]!);
      }
    }
    const snapshot = current.map((row) => [...row]);
    if (dev < bestDev || (dev === bestDev && best !== null && lexSmaller(snapshot, best))) {
      bestDev = dev;
      best = snapshot;
    }
  };

  // 逐分项枚举不减少序列，列和超限即剪枝
  const assignItem = (i: number): void => {
    if (i === n) {
      for (let t = 0; t < periods; t++) if (colSum[t]! !== target[t]!) return;
      consider();
      return;
    }
    const row: number[] = new Array<number>(periods);
    const place = (t: number, minVal: number): void => {
      if (t === periods) {
        current[i] = [...row];
        assignItem(i + 1);
        current[i] = cells[i]!.map((c) => c.lo);
        return;
      }
      for (const v of [cells[i]![t]!.lo, cells[i]![t]!.hi]) {
        if (v < minVal) continue;
        if (colSum[t]! + v - cells[i]![t]!.lo > target[t]!) continue;
        row[t] = v;
        colSum[t]! += v - cells[i]![t]!.lo;
        place(t + 1, v);
        colSum[t]! -= v - cells[i]![t]!.lo;
      }
    };
    place(0, 0);
  };
  assignItem(0);
  assert.ok(best !== null, "brute force found no feasible plan");
  return best;
}

test("随机小批量与暴力枚举一致（全局最优 + 并列次序）", () => {
  const rand = mulberry32(20261007);
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 4);
    const periods = 1 + Math.floor(rand() * 4);
    const amounts: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      let acc = 0;
      for (let t = 0; t < periods; t++) {
        acc += Math.floor(rand() * 25);
        row.push(acc);
      }
      amounts.push(row);
    }
    const expected = bruteForce(amounts);
    const actual = allocateRetention({ amounts });
    assert.deepEqual(
      actual.cumulative,
      expected,
      `mismatch on ${JSON.stringify(amounts)}`,
    );
    // current 与 cumulative 自洽
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < periods; t++) {
        assert.equal(
          actual.current[i]![t],
          actual.cumulative[i]![t]! - (t > 0 ? actual.cumulative[i]![t - 1]! : 0),
        );
      }
    }
  }
});

test("较大批量满足全部硬约束", () => {
  const rand = mulberry32(7);
  const n = 30;
  const periods = 12;
  const amounts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    let acc = 0;
    for (let t = 0; t < periods; t++) {
      acc += Math.floor(rand() * 100000);
      row.push(acc);
    }
    amounts.push(row);
  }
  const result: RetentionBatchResult = allocateRetention({ amounts });
  for (let t = 0; t < periods; t++) {
    let sumAmount = 0;
    let sumRetention = 0;
    for (let i = 0; i < n; i++) {
      sumAmount += amounts[i]![t]!;
      sumRetention += result.cumulative[i]![t]!;
      const lo = Math.floor(amounts[i]![t]! / 10);
      const hi = lo + (amounts[i]![t]! % 10 === 0 ? 0 : 1);
      assert.ok(result.cumulative[i]![t]! === lo || result.cumulative[i]![t]! === hi);
      if (t > 0) assert.ok(result.cumulative[i]![t]! >= result.cumulative[i]![t - 1]!);
    }
    assert.equal(sumRetention, Math.floor((sumAmount + 5) / 10));
  }
});
