# task26100725

QuantLens 相关矩阵估计与修复组件（进程内数值库，TypeScript）。

## API

- `estimateCorrelation(panel)`：按交易日对齐的日收益率面板（行=交易日，列=标的，缺失为 `null`），
  返回 `{ R, W }`。每对标的仅使用双方均非缺失的行计算 Pearson 相关系数（均值在共同样本内计算）；
  共同样本少于 2 个或任一列在共同样本上方差为 0 时相关系数取 0。`R` 对角线固定为 1，
  非对角权重 `W[i][j] = max(共同样本数, 1)`。
- `repairCorrelation(R, W)`：返回 `{ C, objective }`。`C` 对称、半正定、对角线全为 1，
  并使 `sum_{i<j} W[i][j] * (C[i][j] - R[i][j])^2` 达到全局最小
  （加权最近相关矩阵问题，用 majorization + Dykstra 交替投影求解，确定性算法）。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 会先编译（`tsc`）再运行 `node --test`。
