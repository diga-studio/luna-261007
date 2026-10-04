# apr-candidates

商业循环信贷 APR 候选计算库（TypeScript），用于披露生成前核验。全程使用
BigInt 精确有理数运算，不用浮点残差判定根、重数或恒零，因此能完整报告
净现值方程在 `[0, 6]` 内的全部候选 APR（包括偶数重根与区间端点根），
不替调用方选择利率。

## 构建与测试

```sh
npm install
npm test        # 先 tsc 编译到 dist/，再用 node:test 运行 dist/test/*.test.js
```

只依赖 Node.js（>= 18）与 devDependency `typescript`，无其他服务或工具。

## 数据模型

- 输入为若干 `{ month, cents }` 记录：`month` 是从首次放款所在月份起算的
  整数（0 至 24），`cents` 是带符号整数分（`number` 安全整数或 `bigint`），
  借款人收到资金为正，支付还款或费用为负。记录可乱序、同月多笔、正负抵消；
  库内先归并为每月净额 `C[0..24]`，缺失月份为零。
- 净现值定义：`V(a) = Σ C[m] / (1 + a/12)^m`（`m = 0..24`），`a` 为名义年
  利率，`1` 表示 100%。候选 APR 是闭区间 `[0, 6]` 内满足 `V(a) = 0` 的
  所有不同实数。

## 有理数接口

```ts
interface Rational { readonly num: bigint; readonly den: bigint }
```

不变式：`den > 0` 且 `gcd(|num|, den) = 1`，零表示为 `0/1`。构造方式：

- `makeRational(num: bigint, den: bigint)` —— 自动约分、规范化符号；
- `rationalFromBigInt(v: bigint)`；
- `parseRational("3" | "-7/2" | "1.25" | "0.0000000001")` —— 十进制小数
  与分数的精确解析（如 `"1.2"` → `6/5`）。

比较与运算（`add/sub/mul/div/neg/cmp/sign/isZero/toString`）全部为精确运算。

## 库操作

### `analyze(cashflows): AnalysisResult`

```ts
type AnalysisResult =
  | { kind: "none" }                                   // [0,6] 内无根
  | { kind: "indeterminate" }                          // V 恒为零（全部现金流抵消）
  | { kind: "finite"; candidates: readonly Candidate[] };

interface Candidate {
  readonly lower: Rational;      // 闭区间下界，精确有理数
  readonly upper: Rational;      // 闭区间上界，精确有理数
  readonly multiplicity: number; // V 在该根处的零点阶数
}
```

保证：

- 所有区间位于 `[0, 6]` 内，按利率升序、两两不相交；
- 每个区间恰好包含一个不同实根，全部区间覆盖 `[0, 6]` 内所有根；
- 区间宽度 `upper - lower <= 1e-10`；精确根（如有理根、端点根）以零宽
  区间表示（`lower = upper`）；
- 若两个根距离小于 `1e-10`，区间会进一步缩小直到互不相交，绝不合并；
- 输入重排、同月拆分、加入互相抵消的记录，结果完全相同。

### `npv(cashflows, apr): Rational`

`apr` 以精确 `Rational` 传入，返回该利率处的精确有理数净现值
`Σ C[m] / (1 + apr/12)^m`，供调用方独立核验（如验证候选区间端点处的
符号或根处的精确零值）。

## 方法概述

1. 归并现金流得 `C[0..24]`；全零则返回 `indeterminate`。
2. 代换 `t = 1 + a/12`：候选对应整系数多项式
   `F(t) = Σ C[m] t^(24-m)` 在 `t ∈ [1, 3/2]` 内的根，重数保持一致。
3. 对 `F` 做 Yun 无平方因子分解 `F = Π f_i^i`（`f_i` 两两互素、无重根），
   根的重数即其所属因子的下标 `i`。
4. 对无平方部分 `Π f_i` 用 Sturm 序列在 `(1, 3/2)` 内做精确二分隔离，
   每个区间只含一个不同实根；端点 `t = 1`、`t = 3/2` 单独精确判定。
   二分命中精确有理根时记录零宽区间。
5. 每个隔离区间继续二分精化到 `t` 宽度 `≤ 1e-10/12`（映射回 `a` 后
   `≤ 1e-10`）；若相邻候选相交则进一步缩小直至互不相交。
6. 按所属无平方因子确定每个根的重数，映射回 `a = 12(t - 1)` 输出。

全部计算为 BigInt 精确有理数运算：根的存在性由 Sturm 定理（精确符号
变差计数）保证，重数由无平方因子分解保证，均不依赖浮点误差。

## 目录结构

- `src/rational.ts` —— BigInt 精确有理数；
- `src/polynomial.ts` —— 有理系数多项式：四则运算、求导、gcd、Yun 无平方
  因子分解、Sturm 序列与开区间根计数；
- `src/apr.ts` —— `analyze` / `npv` 与输入校验；
- `src/index.ts` —— 公共导出；
- `test/` —— 基于 `node:test` 的自动化测试，以预先已知的精确根核验区间
  包含关系与重数（含 24 次构造案例：端点根、范围外根、重根、无理重根，
  以及乱序/拆分/抵消不变性）。
