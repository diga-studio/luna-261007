# task26100778

固定资产递减余额折旧的批量查询库（TypeScript）。资产集合构建后不可变，构建时不执行任何查询。

## 用法

```ts
import { build, bookValues } from "declining-balance-depreciation";

const book = build([
  { id: "a", purchaseDate: "2024-01-31", price: 1_000_000, salvage: 50_000, lifeMonths: 24, rate: 20000 },
]);

const values = bookValues(book, [
  { id: "a", date: "2024-02-29" },
  { id: "a", date: "2024-03-31" },
]); // (bigint | null)[]，与请求一一对应
```

- 日期为公历日，格式 `YYYY-MM-DD`；金额为整数分（`number` 或 `bigint`，内部一律按 `bigint` 精确计算）。
- `rate` 为万分数：20000 表示 200%。
- 第 k 笔折旧在购置日加 k 个月入账：沿用原购置日的日号，目标月缺该日则取月底，截断不向后传递。
- 前 L-1 笔折旧为 `floor(月初账面值 * r / (10000 * L))`，且不超过账面值减残值；第 L 笔扣至残值。
- 查询计入当天及此前已入账的折旧；购置日前返回 `null`；寿命结束后固定为残值。
- 每个查询的结果与独立逐月执行逐分相等，与请求顺序、重复及批次历史无关。

## 脚本

- `npm run build`：编译到 `dist/`（含类型声明）。
- `npm test`：用 Node 内置测试运行器直接运行 `test/*.test.ts`（Node >= 22.6，含独立逐月参考实现核对）。
- `npm run typecheck`：对 `src/` 与 `test/` 做严格类型检查。
