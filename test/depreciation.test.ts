import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { build, bookValues, type AssetInput, type BookValueRequest } from "../src/index.js";
import { referenceBookValue } from "./reference.js";

// 确定性伪随机数（mulberry32），保证测试可复现。
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoFromDays(days: number): string {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

function daysFromIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86400000;
}

const ASSETS: AssetInput[] = [
  // 月末购置：1/31，2 月入账日应为 2/29（2024 为闰年），其后回到 31 日。
  { id: "month-end", purchaseDate: "2024-01-31", purchasePrice: 1_000_000, salvage: 100_000, lifeMonths: 24, rate: 20000 },
  // 闰日购置：次年 2 月入账日应为 2/28。
  { id: "leap-day", purchaseDate: "2024-02-29", purchasePrice: 500_000, salvage: 0, lifeMonths: 36, rate: 15000 },
  // 普通月折旧不足一分：P=5 分，每月折旧 floor(5*10000/(10000*12))=0，第 12 笔一次结清。
  { id: "tiny", purchaseDate: "2023-06-15", purchasePrice: 5, salvage: 0, lifeMonths: 12, rate: 10000 },
  // 同上但有残值：最终扣至 S。
  { id: "tiny-salvage", purchaseDate: "2023-06-15", purchasePrice: 5, salvage: 2, lifeMonths: 12, rate: 10000 },
  // 常规资产。
  { id: "normal", purchaseDate: "2022-03-10", purchasePrice: 12_345_678, salvage: 1_234_567, lifeMonths: 60, rate: 20000 },
  // 短寿命：L=1，只有一笔，直接扣至 S。
  { id: "one-month", purchaseDate: "2024-04-30", purchasePrice: 999, salvage: 1, lifeMonths: 1, rate: 30000 },
];

test("乱序重复查询与独立逐月参考实现逐分相等", () => {
  const handle = build(ASSETS);
  const rand = rng(42);

  const requests: BookValueRequest[] = [];
  for (const asset of ASSETS) {
    const base = daysFromIso(asset.purchaseDate);
    for (let i = 0; i < 200; i += 1) {
      // 覆盖购置前、购置当天、各入账日前后、寿命结束后。
      const offset = Math.floor(rand() * 2200) - 400;
      requests.push({ assetId: asset.id, date: isoFromDays(base + offset) });
    }
  }
  // 乱序 + 重复。
  for (let i = requests.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [requests[i], requests[j]] = [requests[j]!, requests[i]!];
  }
  requests.push(...requests.slice(0, 300));

  const expected = requests.map((r) =>
    referenceBookValue(ASSETS.find((a) => a.id === r.assetId)!, r.date),
  );
  deepEqual(bookValues(handle, requests), expected);
});

test("月末与闰日入账前后的账面值", () => {
  const handle = build(ASSETS);
  const cases: BookValueRequest[] = [];
  for (const id of ["month-end", "leap-day"]) {
    const asset = ASSETS.find((a) => a.id === id)!;
    const base = daysFromIso(asset.purchaseDate);
    for (let offset = -2; offset <= 800; offset += 1) {
      cases.push({ assetId: id, date: isoFromDays(base + offset) });
    }
  }
  const expected = cases.map((r) =>
    referenceBookValue(ASSETS.find((a) => a.id === r.assetId)!, r.date),
  );
  deepEqual(bookValues(handle, cases), expected);

  // 关键入账日点检：2024-01-31 购置，首笔应于 2024-02-29（闰日）入账。
  const monthEnd = ASSETS.find((a) => a.id === "month-end")!;
  const firstDep = (1_000_000n * 20000n) / (10000n * 24n); // 83333
  const [before, on, after] = bookValues(handle, [
    { assetId: "month-end", date: "2024-02-28" },
    { assetId: "month-end", date: "2024-02-29" },
    { assetId: "month-end", date: "2024-03-01" },
  ]);
  equal(before, 1_000_000n);
  equal(on, 1_000_000n - firstDep);
  equal(after, 1_000_000n - firstDep);
  // 第 2 笔回到 31 日入账（不沿用 2 月的截断日）。
  const secondBase = 1_000_000n - firstDep;
  const secondDep = (secondBase * 20000n) / (10000n * 24n);
  const [d30, d31] = bookValues(handle, [
    { assetId: "month-end", date: "2024-03-30" },
    { assetId: "month-end", date: "2024-03-31" },
  ]);
  equal(d30, secondBase);
  equal(d31, secondBase - secondDep);
  // 闰日购置：第 12 笔于 2025-02-28 入账（2025 非闰年）。
  const leap = ASSETS.find((a) => a.id === "leap-day")!;
  const [feb27, feb28] = bookValues(handle, [
    { assetId: "leap-day", date: "2025-02-27" },
    { assetId: "leap-day", date: "2025-02-28" },
  ]);
  equal(feb27, referenceBookValue(leap, "2025-02-27"));
  equal(feb28, referenceBookValue(leap, "2025-02-28"));
  equal(feb27! - feb28! > 0n, true);
});

test("普通月折旧不足一分而最终结清的资产", () => {
  const handle = build(ASSETS);
  // 前 11 笔折旧均为 0 分，账面值保持 5 分；第 12 笔（2024-06-15）扣至 S=0。
  deepEqual(
    bookValues(handle, [
      { assetId: "tiny", date: "2023-06-14" },
      { assetId: "tiny", date: "2023-06-15" },
      { assetId: "tiny", date: "2024-06-14" },
      { assetId: "tiny", date: "2024-06-15" },
      { assetId: "tiny", date: "2030-01-01" },
    ]),
    [null, 5n, 5n, 0n, 0n],
  );
  // 有残值版本：最终扣至 2 分并保持。
  deepEqual(
    bookValues(handle, [
      { assetId: "tiny-salvage", date: "2024-06-14" },
      { assetId: "tiny-salvage", date: "2024-06-15" },
      { assetId: "tiny-salvage", date: "2030-01-01" },
    ]),
    [5n, 2n, 2n],
  );
});

test("结果不受请求乱序、重复或批次历史影响", () => {
  const handle = build(ASSETS);
  const probe: BookValueRequest[] = [
    { assetId: "normal", date: "2023-05-10" },
    { assetId: "month-end", date: "2024-02-29" },
    { assetId: "leap-day", date: "2025-02-28" },
    { assetId: "tiny", date: "2024-06-15" },
  ];
  const first = bookValues(handle, probe);
  // 先跑一大批无关查询（批次历史），再以不同顺序、带重复地查同样的内容。
  const rand = rng(7);
  const noise: BookValueRequest[] = [];
  for (let i = 0; i < 5000; i += 1) {
    const asset = ASSETS[Math.floor(rand() * ASSETS.length)]!;
    noise.push({ assetId: asset.id, date: isoFromDays(daysFromIso(asset.purchaseDate) + Math.floor(rand() * 1500) - 100) });
  }
  bookValues(handle, noise);
  const shuffled = [probe[3]!, probe[1]!, probe[0]!, probe[2]!, probe[1]!, probe[3]!];
  const second = bookValues(handle, shuffled);
  deepEqual([second[2], second[1], second[3], second[0]], first);
  deepEqual(second[1], second[4]); // 重复请求结果一致
  deepEqual(second[0], second[5]);
});

test("购置前返回 null，寿命结束后固定为残值", () => {
  const handle = build(ASSETS);
  const [pre, farFuture] = bookValues(handle, [
    { assetId: "normal", date: "2022-03-09" },
    { assetId: "normal", date: "2099-12-31" },
  ]);
  equal(pre, null);
  equal(farFuture, 1_234_567n);
});

test("输入校验与不可变性", () => {
  throws(() => build([{ id: "x", purchaseDate: "2024-01-01", purchasePrice: 1, salvage: 0, lifeMonths: 1, rate: 0 },
    { id: "x", purchaseDate: "2024-01-01", purchasePrice: 1, salvage: 0, lifeMonths: 1, rate: 0 }]));
  throws(() => build([{ id: "bad", purchaseDate: "2023-02-29", purchasePrice: 1, salvage: 0, lifeMonths: 1, rate: 0 }]));
  throws(() => build([{ id: "neg", purchaseDate: "2024-01-01", purchasePrice: 1, salvage: 2, lifeMonths: 1, rate: 0 }]));
  const handle = build(ASSETS);
  throws(() => bookValues(handle, [{ assetId: "nope", date: "2024-01-01" }]));
  // 同一 handle 可无限复用，结果稳定。
  const a = bookValues(handle, [{ assetId: "normal", date: "2024-01-01" }]);
  const b = bookValues(handle, [{ assetId: "normal", date: "2024-01-01" }]);
  deepEqual(a, b);
});
