# task26100795

门店 NAP 一致性判定库（TypeScript）。由上层传入规范资料、目录资料和本地地址规则，
返回判定与核验依据；纯函数，无持久化副作用。

## 使用

```ts
import { evaluateStore } from "nap-consistency";

const result = evaluateStore(canonicalProfile, directoryProfileOrNull, rules);
// result.verdict: "consistent" | "conflict" | "missing" | "needs_review"
// verdict 为 "needs_review" 时 result.evidence 附人工复核依据
```

- 目录资料传 `null` 判定为 `missing`。
- 名称、电话、城市、州、邮编、独立单元号逐项精确比较，任一不同即 `conflict`。
- 街道文本按空白切词元（忽略 ASCII 大小写，保留标点），双方分别应用适合
  其州的规则生成解释；优先级依次为：限州规则覆盖原词元数最多、总覆盖最多、
  使用规则数最少。同优先级解释全部有效。
- 双方全部有效解释得到同一词元序列为 `consistent`；无共同序列为 `conflict`；
  其余为 `needs_review` 并附共同序列与双方各自不同的有效序列。

## 构建与测试

```sh
npm install
npm test
```
