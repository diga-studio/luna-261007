# nurse-allocation-advisor

医疗资源调配建议库（TypeScript，纯进程内存，无外部服务依赖）。

在护士总量不变的前提下，根据各科室候选配置，给出整体评分达到目标的调配建议：
每个科室恰好选择一个候选人数，总人数守恒，锁定科室保持不变；在所有达标组合中
先取总调整费用最低，再取人数发生变化的科室数量最少。

## 使用

```ts
import { solveAllocation } from "nurse-allocation-advisor";

const result = solveAllocation({
  targetScore: 20,
  departments: [
    {
      id: "A",
      currentNurses: 3,
      candidates: [
        { nurses: 3, score: 5, cost: 0 },   // 当前人数必须在候选中且费用为 0
        { nurses: 5, score: 12, cost: 30 },
      ],
    },
    // ...
  ],
});

if (result.feasible) {
  console.log(result.changes);      // 各改动科室：人数、收益（贡献分变化）、费用
  console.log(result.explanation);  // 与最终组合一致的文字解释
} else {
  console.log(result.reason);       // 明确不可达，不会把接近目标的配置当作成功
}
```

- 一次计算只涉及一个班次，护士为可互换整数资源。
- 同一科室人数增加时贡献分不得下降（允许持平与跳升），输入违反时抛错。
- 当前配置已达标时返回不作调整的建议（费用 0、0 个科室改动）。

## 构建与测试

```sh
npm install
npm test        # 编译 src + test 并运行 node:test 测试
npm run build   # 仅编译库到 dist/
```

仅依赖 Node.js 与 devDependencies 中的 typescript / @types/node。
