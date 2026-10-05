# declining-balance-depreciation

固定资产递减余额折旧的批量查询库（TypeScript）。资产集合在 `build` 后不可变，
所有金额以整数分表示，乘除中间值用 `bigint` 精确计算。

## 使用

```ts
import { build, bookValues } from "declining-balance-depreciation";

const handle = build([
  {
    id: "machine-1",
    purchaseDate: "2024-01-31", // 公历日 YYYY-MM-DD
    purchasePrice: 1_000_000,   // 购置价 P，整数分（number 或 bigint）
    salvage: 100_000,           // 残值 S，整数分
    lifeMonths: 24,             // 寿命 L（月）
    rate: 20000,                // 递减倍数 r，万分数：20000 = 200%
  },
]);

const values = bookValues(handle, [
  { assetId: "machine-1", date: "2024-02-28" }, // 首笔入账前 → 1_000_000n
  { assetId: "machine-1", date: "2024-02-29" }, // 首笔入账日 → 扣除第 1 笔
  { assetId: "machine-1", date: "2023-12-31" }, // 购置前 → null
]);
```

## 规则

- 第 k 笔折旧在购置日加 k 个月时入账：保留原日号，目标月缺该日则取月底，
  不沿用上月截断结果。
- 前 L-1 笔：`floor(月初账面值 * r / (10000 * L))`，且不超过账面值减 S；
  第 L 笔扣至 S。
- 查询计入当天及此前已入账折旧；购置前返回 `null`；寿命结束后固定为 S。
- 每个查询与独立逐月执行规则的结果逐分相等，不受请求乱序、重复或批次历史影响。

## 构建与测试

```sh
npm install
npm test
```

测试用独立的逐月参考实现（`test/reference.ts`，基于 `Date.UTC`，与库内部
历法实现相互独立）核对批量查询结果，覆盖乱序重复查询、月末与闰日入账、
以及普通月折旧不足一分而最终结清的资产。
