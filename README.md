# nap-consistency

门店 NAP（名称、地址、电话）一致性判定库。上层传入规范资料、目录资料和本地地址规则，直接返回判定与核验依据，无任何持久化副作用。

## 使用

```ts
import { judgeNap } from "nap-consistency";

const judgment = judgeNap(canonical, directory, rules);
```

- `canonical` / `directory`：`NapRecord`（名称、电话、城市、州、邮编、单元号已统一格式）；`directory` 为 `null` 时判定为 `missing`。
- `rules`：`AddressRule[]`，每条规则把连续输入词组替换为非空输出词组（不得含数字词元），`state` 为 `null` 表示通用。

## 判定

- 名称、电话、城市、州、邮编、单元号逐项精确比较，任一不同即 `conflict`（含一侧有单元号而另一侧没有）。
- 仅街道文本参与歧义判定：双方分别应用适合其州的规则，取业务优先级最高（限州覆盖词元数 → 总覆盖词元数 → 规则数最少）的全部有效解释。
- 双方全部有效解释得到同一词元序列 → `consistent`；无共同序列 → `conflict`；其余 → `needs_review`，并附共同序列与双方各一个彼此不同的有效序列。

## 开发

```sh
npm install
npm test
```
