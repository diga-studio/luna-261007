# nurse-staffing-advisor

医疗资源调配建议库（TypeScript，纯进程内存，无外部服务依赖）。

在护士总量不变的前提下，为每个科室从候选人数中选择一个方案，使整体评分达到目标；
在所有达标组合中，先选总调整费用最低的，再选人数发生变化的科室数量最少的。

## 使用

```ts
import { suggestStaffing } from "nurse-staffing-advisor";

const advice = suggestStaffing(
  [
    {
      id: "icu",
      currentHeadcount: 5,
      locked: false, // 锁定科室必须保持当前人数
      candidates: [
        { headcount: 5, score: 40, cost: 0 },  // 当前配置必须在候选中且费用为 0
        { headcount: 7, score: 55, cost: 30 }, // score: 折算后的整数贡献分, cost: 整数调整费用
        { headcount: 3, score: 30, cost: 10 },
      ],
    },
    // ...更多科室
  ],
  100, // 目标总分（整数）
);

if (advice.reachable) {
  for (const c of advice.changes) {
    // c: { departmentId, fromHeadcount, toHeadcount, scoreGain, cost }
  }
} else {
  // 目标不可达，不会把接近目标的配置当作成功
}
```

## 规则

- 一次计算只涉及一个班次，护士是可互换的整数资源；建议人数总和等于当前人数总和。
- 每个科室恰好选择一个候选；候选人数互异；同一科室人数增加时贡献分不下降。
- 总分 ≥ 目标即达标；当前配置已达标时返回不作调整的建议。
- 结果包含各改动科室的调整与收益说明（`changes`）及人类可读摘要（`summary`）。

## 开发

```sh
npm install   # 仅安装 typescript（devDependency）
npm run build # 编译到 dist/
npm test      # 使用 Node.js 内置测试运行器，无需额外依赖
```
