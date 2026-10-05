# resume-match

招聘履历匹配评分库（TypeScript，纯内存计算，无接口层/持久化）。由上层调用方传入岗位与候选人的结构化履历，返回最优匹配分与可逐项复核的月份分配说明。

## 使用

```ts
import { scoreCandidate } from "resume-match";

const result = scoreCandidate(
  {
    requirements: [
      { skill: "TypeScript", targetMonths: 24, weight: 3 },
      { skill: "React", targetMonths: 12, weight: 2 },
    ],
  },
  [
    { startMonth: "2024-01", endMonth: "2025-06", skills: ["TypeScript", "React"] },
  ],
  "2025-06", // 基准月份：只使用含该月在内的最近 60 个自然月
);

// result.score        匹配分 = 100 * 分子 / 分母
// result.allocations  月份分配说明（月份、技能、点数、加权得分）
```

## 评分规则

- 窗口：含基准月份在内的最近 60 个自然月；其中最近 12 个月每月贡献 2 点，其余 48 个月每月 1 点。
- 某月可证明的技能 = 覆盖该月的所有履历技能的并集（重叠履历、重复记录、重复技能不增加证据）。
- 每个月最多分配给一项岗位技能（也可以不分配）；每项技能所得月数不超过其目标月数。
- 分子 = 已分配月份的 `点数 × 技能权重` 之和；分母 = `2 × Σ(目标月数 × 权重)`。
- 返回所有合法分配中的最高分（内部以最小费用流求最大权分配），多个最优解时任取其一。

## 构建与测试

```sh
npm install
npm test        # 先编译（pretest）再运行 node:test 测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js；开发依赖（typescript、@types/node）均在 package.json 中声明。
