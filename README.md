# task26100714

## succession-planner

无状态的继任覆盖规划库。`planSuccession(model)` 返回一份跨就绪时点一致的
岗位—员工预留方案（不是逐岗位推荐名单）：每个岗位最多预留一人，每名员工
在整个方案中最多出现一次，允许岗位空缺，只选择输入名单内的配对。

```ts
import { planSuccession } from "./src/index";

const plan = planSuccession({ jobs, employees, candidates });
// plan.reservations: [{ jobId, employeeId, readiness, gap }]
// plan.metrics:      { c0, c1, c2, maxGap, totalGap }
```

### 技能缺口

`gap = floor(10000 * Σ max(required - actual, 0) * weight / Σ required * weight)`，
缺失技能按 `actual = 0` 处理，见 `src/gap.ts`。

### 最优性

返回全局精确最优解，目标按字典序：最大化 C0（就绪 0 的配对数）→ 最大化
C1（就绪 0/1）→ 最大化 C2（全部）→ 最小化已选配对的最大 gap → 最小化
gap 总和。求解分三步（`src/planSuccession.ts`）：

1. **覆盖向量**：令 `n = min(岗位数, 员工数)`、`M = n + 1`，就绪级别
   0/1/2 的边分别赋权 `M²+M+1`、`M+1`、`1`。由于任何匹配至多 `n < M`
   条边，该混合进制编码与 `(C0, C1, C2)` 的字典序一一对应，一次最大权
   匹配即得最优覆盖向量 `W*`。
2. **最大 gap 阈值**：对所有不同 gap 值二分查找最小阈值 `T`，使得只用
   `gap ≤ T` 的边仍能达到权重 `W*`（可行性关于 `T` 单调）。
3. **gap 总和**：在 `gap ≤ T` 的边上以费用 `gap - BIG * levelWeight`
   （`BIG = n * 10000 + 1`，大于任何可能的 gap 总和）求最小费用匹配，
   保持覆盖向量与最大 gap 最优的前提下最小化 gap 总和。

匹配用带 Johnson 势的逐条最短路增广实现（`src/mcmf.ts`），只在增广路
费用为负时增广，天然支持“允许空缺”的非完美匹配。

### 复杂度

设 `J` 为岗位数、`E` 为员工数、`P` 为候选配对数、`G` 为不同 gap 值
个数（`G ≤ P`）。单次匹配 `O(n · P log(J + E))`，其中 `n = min(J, E)`
为增广次数；总复杂度 `O((log G + 1) · n · P log(J + E))`，空间
`O(J + E + P)`。

### 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test
```

测试直接调用库，覆盖：连续争用链（局部最优阻断其他岗位）、提升 C0 必须
牺牲 C2 的场景（验证没有按总覆盖数求解）、覆盖数相同但“总 gap 更小、
最大 gap 更大”的场景（验证优先保护最差岗位），以及 300 个随机小模型与
暴力枚举最优解的对拍。
