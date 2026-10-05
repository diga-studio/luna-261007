# resume-match

招聘履历匹配库（TypeScript，纯内存计算，无接口层、无持久化）。
岗位与候选人的结构化履历由调用方传入，库负责在有限的工作月份上
分配经验信用，返回所有合法分配中“最有利于候选人”的匹配分，
并附可逐项复核的月份分配说明。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js；`typescript` 与 `@types/node` 为本仓库声明的全部
开发依赖。`npm run build` 产出 `dist/`（含类型声明）。

## 评分规则

- 基准月份由调用方传入，只考察含基准月在内的最近 60 个自然月。
- 岗位包含互不重复的技能要求，每项有目标经验月数与权重。
- 履历条目含起止月份（均计入）与技能集合；某月可证明的技能是
  覆盖该月的所有履历技能的并集。重叠、重复记录或重复技能不会
  增加该月证据。
- 每个有效月份最多分配给一项它能证明的岗位技能（也可以不用）；
  每项技能分得的月份不超过其目标月数。
- 含基准月的最近 12 个月每月 2 点，其余 48 个月每月 1 点；该月
  加权得分 = 点数 × 所分配技能的权重。
- 匹配分 = 100 × 已分配月份加权得分之和 ÷（2 × Σ目标月数×权重）。
  通过最小费用最大流求得所有合法分配中的最高分。

## 用法

```ts
import { scoreResume } from "resume-match";

const result = scoreResume(
  {
    requirements: [
      { skill: "typescript", targetMonths: 12, weight: 2 },
      { skill: "react", targetMonths: 6, weight: 1 },
    ],
  },
  [
    { startMonth: "2024-01", endMonth: "2025-06", skills: ["typescript", "react"] },
  ],
  "2025-06", // 基准月份，"YYYY-MM"
);

result.score;       // 0–100 的匹配分
result.numerator;   // 已分配月份加权得分之和
result.denominator; // 2 × Σ(目标月数 × 权重)
result.allocations; // 每月的分配说明：月份、技能、点数、加权得分
```

`allocations` 中的月份均有履历支持、互不重复，其 `weightedScore`
之和等于 `numerator`，可据此还原评分。

## 结构

- `src/types.ts` — 对外类型（`Job`、`ResumeEntry`、`MatchResult` 等）
- `src/months.ts` — 月份运算（窗口、偏移）
- `src/evidence.ts` — 每月可证明技能集合（去重、并集）
- `src/matching.ts` — 月份×技能的最优分配（最小费用最大流）
- `src/score.ts` — 评分入口 `scoreResume`
- `test/score.test.ts` — node:test 自动化测试
