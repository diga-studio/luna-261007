"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { allocateRetainageBatch } = require("../dist/index.js");

/** 展开求解结果为 cumulative[t][i]。 */
function cumulativeOf(result) {
  return result.periods.map((p) => p.items.map((it) => it.cumulativeCents));
}

/** 暴力枚举全部合法方案，返回 {bestDeviation, bestCumulative}。 */
function bruteForce(amounts) {
  const T = amounts.length;
  const n = amounts[0].length;
  const lo = amounts.map((row) => row.map((a) => Math.floor(a / 10)));
  const choices = amounts.map((row) =>
    row.map((a) => (a % 10 === 0 ? [0] : [0, 1])),
  );
  const need = amounts.map((row, t) => {
    const total = row.reduce((s, a) => s + a, 0);
    const loSum = lo[t].reduce((s, v) => s + v, 0);
    return Math.floor(total / 10) + (total % 10 >= 5 ? 1 : 0) - loSum;
  });

  // 每期满足合计约束的 x 向量
  const perPeriod = [];
  for (let t = 0; t < T; t++) {
    const vecs = [];
    const walk = (i, left, acc) => {
      if (i === n) {
        if (left === 0) vecs.push(acc.slice());
        return;
      }
      for (const x of choices[t][i]) {
        acc.push(x);
        walk(i + 1, left - x, acc);
        acc.pop();
      }
    };
    walk(0, need[t], []);
    perPeriod.push(vecs);
  }

  let bestDev = null;
  let bestCum = null;
  const consider = (xs) => {
    // xs[t][i] 为是否向上取整；校验单调性
    for (let i = 0; i < n; i++) {
      for (let t = 1; t < T; t++) {
        if (lo[t][i] + xs[t][i] < lo[t - 1][i] + xs[t - 1][i]) return;
      }
    }
    const cum = xs.map((vec, t) => vec.map((x, i) => lo[t][i] + x));
    let dev = 0;
    for (let t = 0; t < T; t++)
      for (let i = 0; i < n; i++)
        dev += Math.abs(cum[t][i] * 10 - amounts[t][i]);
    const lexLess = (a, b) => {
      for (let t = 0; t < T; t++)
        for (let i = 0; i < n; i++) {
          if (a[t][i] !== b[t][i]) return a[t][i] < b[t][i];
        }
      return false;
    };
    if (
      bestDev === null ||
      dev < bestDev ||
      (dev === bestDev && lexLess(cum, bestCum))
    ) {
      bestDev = dev;
      bestCum = cum;
    }
  };
  const combine = (t, acc) => {
    if (t === T) {
      consider(acc);
      return;
    }
    for (const vec of perPeriod[t]) {
      acc.push(vec);
      combine(t + 1, acc);
      acc.pop();
    }
  };
  combine(0, []);
  return { bestDev, bestCum };
}

function deviationOf(amounts, cum) {
  let dev = 0;
  for (let t = 0; t < amounts.length; t++)
    for (let i = 0; i < amounts[0].length; i++)
      dev += Math.abs(cum[t][i] * 10 - amounts[t][i]);
  return dev;
}

test("多期全局最优：不能为降低单期偏差而让分项倒退", () => {
  const result = allocateRetainageBatch({
    periodsCents: [
      [4, 2],
      [4, 9],
    ],
  });
  assert.deepEqual(cumulativeOf(result), [
    [0, 1],
    [0, 1],
  ]);
  // 偏差总和为 17 个十分之一分
  assert.equal(
    deviationOf(
      [
        [4, 2],
        [4, 9],
      ],
      cumulativeOf(result),
    ),
    17,
  );
  // 本期新增：首期即累计，次期为 0
  assert.deepEqual(
    result.periods.map((p) => p.items.map((it) => it.currentCents)),
    [
      [0, 1],
      [0, 0],
    ],
  );
});

test("单期并列方案按分项顺序取较小值，且结果可重复", () => {
  const input = { periodsCents: [[5, 5]] };
  const first = allocateRetainageBatch(input);
  assert.deepEqual(cumulativeOf(first), [[0, 1]]);
  const second = allocateRetainageBatch(input);
  assert.deepEqual(cumulativeOf(second), [[0, 1]]);
  assert.deepEqual(first, second);
});

test("精确 10% 为整数分时必须保持该值", () => {
  const result = allocateRetainageBatch({
    periodsCents: [
      [10, 20],
      [30, 40],
    ],
  });
  assert.deepEqual(cumulativeOf(result), [
    [1, 2],
    [3, 4],
  ]);
});

test("合计恰好半分时向上进一分", () => {
  // 合计 15 分 -> 1.5 分 -> 2 分
  const result = allocateRetainageBatch({ periodsCents: [[15]] });
  assert.deepEqual(cumulativeOf(result), [[2]]);
});

test("本期新增等于累计之差，首期期初为 0", () => {
  const result = allocateRetainageBatch({
    periodsCents: [
      [13, 7],
      [25, 19],
      [25, 44],
    ],
  });
  const cum = cumulativeOf(result);
  result.periods.forEach((p, t) => {
    p.items.forEach((it, i) => {
      const prev = t > 0 ? cum[t - 1][i] : 0;
      assert.equal(it.currentCents, it.cumulativeCents - prev);
      assert.ok(it.currentCents >= 0, "累计扣留款不得倒退");
    });
  });
});

test("小金额随机用例与暴力枚举完全一致（全局最优 + 并列次序）", () => {
  let seed = 20261007;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + (rand() % 4);
    const T = 1 + (rand() % 4);
    const amounts = [];
    for (let t = 0; t < T; t++) {
      const row = [];
      for (let i = 0; i < n; i++) {
        const prev = t > 0 ? amounts[t - 1][i] : 0;
        const step = trial % 3 === 0 ? 1000 : trial % 3 === 1 ? 25 : 7;
        row.push(prev + (rand() % step));
      }
      amounts.push(row);
    }
    const result = allocateRetainageBatch({ periodsCents: amounts });
    const cum = cumulativeOf(result);
    const brute = bruteForce(amounts);
    assert.equal(
      deviationOf(amounts, cum),
      brute.bestDev,
      `第 ${trial} 例偏差非最优: ${JSON.stringify(amounts)}`,
    );
    assert.deepEqual(
      cum,
      brute.bestCum,
      `第 ${trial} 例并列次序不符: ${JSON.stringify(amounts)}`,
    );
  }
});

test("输入校验", () => {
  assert.throws(() => allocateRetainageBatch({ periodsCents: [[1.5]] }));
  assert.throws(() => allocateRetainageBatch({ periodsCents: [[-1]] }));
  assert.throws(() =>
    allocateRetainageBatch({
      periodsCents: [
        [5, 5],
        [4, 5],
      ],
    }),
  );
  assert.throws(() =>
    allocateRetainageBatch({ periodsCents: [[1], [1, 2]] }),
  );
  assert.deepEqual(allocateRetainageBatch({ periodsCents: [] }), {
    periods: [],
  });
});

test("较大批次性能与不变量（50 分项 x 24 期）", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const n = 50;
  const T = 24;
  const amounts = [];
  for (let t = 0; t < T; t++) {
    const row = [];
    for (let i = 0; i < n; i++) {
      const prev = t > 0 ? amounts[t - 1][i] : 0;
      row.push(prev + (rand() % 500000));
    }
    amounts.push(row);
  }
  const start = Date.now();
  const result = allocateRetainageBatch({ periodsCents: amounts });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10000, `耗时 ${elapsed}ms 超出预期`);
  const cum = cumulativeOf(result);
  for (let t = 0; t < T; t++) {
    let total = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      total += amounts[t][i];
      sum += cum[t][i];
      const lo = Math.floor(amounts[t][i] / 10);
      assert.ok(cum[t][i] === lo || cum[t][i] === lo + 1);
      if (t > 0) assert.ok(cum[t][i] >= cum[t - 1][i]);
    }
    const expected = Math.floor(total / 10) + (total % 10 >= 5 ? 1 : 0);
    assert.equal(sum, expected);
  }
});

test("同一 floor 区间内整十分前缀强制取精确值", () => {
  // 第 1 期 10 分（精确 1 分），第 2 期 15 分（1.5 -> 2 分）
  const result = allocateRetainageBatch({ periodsCents: [[10], [15]] });
  assert.deepEqual(cumulativeOf(result), [[1], [2]]);
  assert.deepEqual(
    result.periods.map((p) => p.items.map((it) => it.currentCents)),
    [[1], [1]],
  );
});

test("零金额批次全部为零", () => {
  const result = allocateRetainageBatch({
    periodsCents: [
      [0, 0],
      [0, 0],
    ],
  });
  assert.deepEqual(cumulativeOf(result), [
    [0, 0],
    [0, 0],
  ]);
  assert.deepEqual(
    result.periods.map((p) => p.items.map((it) => it.currentCents)),
    [
      [0, 0],
      [0, 0],
    ],
  );
});

test("金额不变的分项扣留款保持不变", () => {
  // 分项 B 金额不变，其累计扣留款不得变化；新增全部落在 A 上
  const result = allocateRetainageBatch({
    periodsCents: [
      [3, 6],
      [13, 6],
    ],
  });
  const cum = cumulativeOf(result);
  assert.equal(cum[0][1], cum[1][1]);
  assert.equal(result.periods[1].items[1].currentCents, 0);
});
