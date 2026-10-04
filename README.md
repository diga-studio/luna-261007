# apr-candidates

商业循环信贷 APR 候选计算库，供披露生成前核验。全部计算基于精确有理数
（BigInt 分子/分母），不使用任何浮点残差判定。

## 数学口径

- 输入为若干 `{ month, cents }` 记录：`month` 是首次放款所在月份起算的整数
  （0–24），`cents` 为带符号整数分（借款人收款为正，还款/费用为负）。
  记录可乱序、同月多笔、正负抵消；库内先归并为 `C[0..24]`。
- 净现值 `V(a) = Σ C[m] / (1 + a/12)^m`，`a` 为名义年利率（1 = 100%）。
- 候选 APR 是闭区间 `[0, 6]` 内满足 `V(a) = 0` 的全部不同实数。
- 令 `x = 1 + a/12 ∈ [1, 3/2]`，则 `V(a) = x^-24 · P(x)`，
  `P(x) = Σ C[m]·x^(24-m)` 为整系数多项式。`x^-24 > 0` 且 `dx/da = 1/12 ≠ 0`，
  因此 `V` 在 `[0,6]` 上的根与 `P` 在 `[1,3/2]` 上的根一一对应且重数相同。
- 根的完备性与重数通过精确符号代数获得：Yun 无平方分解
  `P = Π Q_i^i`（`Q_i` 的根在 `P` 中重数恰为 `i`），再用 Sturm 序列在
  `[1, 3/2]` 上做区间二分隔离，覆盖单根、偶数重根与区间端点根，
  不依赖符号变号或固定步长扫描。

## 接口

```ts
import { analyze, npv, Rational } from "./src/apr"; // 或编译后的 dist/src/apr

analyze(records: CashflowRecord[]): AnalysisResult
npv(records: CashflowRecord[], apr: Rational): Rational
```

- `CashflowRecord = { month: number; cents: bigint | number }`。
- `AnalysisResult`：
  - `{ kind: "none" }` —— `[0,6]` 内无候选；
  - `{ kind: "indeterminate" }` —— `V` 恒为零（归并后各月金额全为 0）；
  - `{ kind: "finite", candidates: AprCandidate[] }` —— 全部候选。
- `AprCandidate = { lower: Rational; upper: Rational; multiplicity: number }`：
  闭区间 `[lower, upper]` 恰好包含一个不同实根，宽度 `≤ 1e-10`，
  精确根表示为零宽区间；候选按利率升序且互不相交，合起来覆盖范围内所有根；
  `multiplicity` 是 `V` 在该利率处的零点阶数。
- `Rational` 为精确有理数：`Rational.of(num, den?)` 接受
  `bigint | number | string`，内部恒约分（`den > 0`），支持
  `add/sub/mul/div/neg/compare/equals/sign/isZero/toString`。
- `npv` 以精确有理数返回 `V(apr)`，供调用方独立核验（例如候选区间中
  精确根的 `npv` 必为严格 0）。

## 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test
```

测试用预先已知的精确根核验区间包含关系与重数（含 1.2 二重根、
1.2 与 1.20000012 双单根隔离、24 次多项式的端点根/范围外根/重根，
以及乱序、同月拆分、相互抵消记录下的结果不变性）。
