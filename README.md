# task26100725 — QuantLens 相关矩阵估计与修复

进程内数值库（TypeScript，无运行时依赖）。输入为按交易日对齐的日收益率面板
（行 = 交易日，列 = 标的，缺失值为 `null`）。

## API

- `estimateCorrelation(panel)` → `{ R, W }`
  - 每对标的仅使用双方均非缺失的行计算 Pearson 相关系数，均值也在该共同样本内计算。
  - 共同样本少于 2 个，或任一列在共同样本上方差为 0 时，相关系数取 0。
  - `R` 对角线固定为 1；非对角权重 `W[i][j] = max(共同样本数, 1)`；`W` 对角线为 0（不参与修复目标）。
- `repairCorrelation(R, W)` → `{ C, objective }`
  - 返回对称、半正定、对角线全为 1 的矩阵 `C`，使
    `Σ_{i<j} W[i][j]·(C[i][j]−R[i][j])²` 达到全局最小（`objective` 即该目标值）。
  - 已满足约束的 `R` 原样返回（目标值为 0）；奇异矩阵是合法结果。

## 实现要点

- `src/estimate.ts`：两两重叠样本的 Pearson 估计。
- `src/repair.ts`：加权最近相关矩阵问题，ADMM 交替投影（加权最小二乘更新 +
  PSD 锥投影），凸问题保证全局最优；输入已合法时直接返回。
- `src/linalg.ts`：循环 Jacobi 特征分解（确定性，无外部依赖）。

## 构建与测试

```sh
npm install
npm test
```

`npm test` 先执行 `tsc` 构建到 `dist/`，再用 Node 内置测试运行器跑
`dist/test/*.test.js`。开发依赖（`typescript`、`@types/node`）均在
`package.json` 中声明。
