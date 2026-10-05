# task26100799

NodeForge 灰度模板版本库（单模板、进程内状态）。

## 要求

- Node.js >= 22.18（依赖 Node 原生 TypeScript 类型擦除运行 `.ts`，无任何第三方依赖）

## 使用

```bash
npm install
npm test
```

## API

```ts
import { GrayTemplateStore } from "./src/index.ts";

const store = new GrayTemplateStore({ baselineText: "基线正文" });

const versionId = store.publish("新模板正文");      // 不可变版本，返回版本 ID
const members = store.rollout("batch-1", versionId, ["n1", "n2", "n3"], 50);
store.withdraw("batch-1");                          // 可重复调用
const out = await store.render(["n1"], async (nodeId, text) => `${nodeId}:${text}`);
```

- 百分比仅支持 10 / 25 / 50 / 100，人数向上取整；选人按节点 ID 哈希排序，
  与输入顺序无关，且不同百分比的选中集合嵌套。
- 节点有效版本 = 覆盖该节点且未撤回的最后创建批次；否则为基线。
- `batchId` 是幂等键：重试返回原批次，已撤回的批次不会因重试复活。
