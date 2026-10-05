// 独立逐月参考实现：刻意不复用 src/ 的任何代码。
// 日期推算基于 Date.UTC（与 src/date.ts 的纯历法实现相互独立），
// 折旧按查询日期逐月模拟入账，用于核对批量查询结果逐分相等。

import type { AssetInput } from "../src/index.js";

function toDays(date: { y: number; m: number; d: number }): number {
  return Date.UTC(date.y, date.m - 1, date.d) / 86400000;
}

function parse(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

// 独立实现的“加 k 个月”：保留原日号，目标月缺该日取月底。
function addMonthsRef(purchase: { y: number; m: number; d: number }, k: number): number {
  const firstOfTarget = new Date(Date.UTC(purchase.y, purchase.m - 1 + k, 1));
  const y = firstOfTarget.getUTCFullYear();
  const m = firstOfTarget.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(purchase.d, lastDay)) / 86400000;
}

/** 逐月执行规则，返回 queryDate 当天及此前已入账折旧后的账面值；购置前返回 null。 */
export function referenceBookValue(asset: AssetInput, queryIso: string): bigint | null {
  const purchase = parse(asset.purchaseDate);
  const query = toDays(parse(queryIso));
  if (query < toDays(purchase)) return null;

  let bookValue = BigInt(asset.purchasePrice);
  const salvage = BigInt(asset.salvage);
  const rate = BigInt(asset.rate);
  const divisor = 10000n * BigInt(asset.lifeMonths);

  for (let k = 1; k <= asset.lifeMonths; k += 1) {
    if (addMonthsRef(purchase, k) > query) break; // 第 k 笔尚未入账
    let dep: bigint;
    if (k < asset.lifeMonths) {
      dep = (bookValue * rate) / divisor;
      const cap = bookValue - salvage;
      if (dep > cap) dep = cap;
    } else {
      dep = bookValue - salvage;
    }
    bookValue -= dep;
  }
  return bookValue;
}
