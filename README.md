# NodeForge 灰度模板版本库

单模板的灰度发布 / 撤回 / 渲染，进程内状态。

## 使用

```bash
npm install
npm test
```

```ts
import { TemplateStore } from "./src/templateStore.js";

const store = new TemplateStore("baseline text");
const v1 = store.publish("new template text");
const members = store.rollout("batch-1", v1, ["n1", "n2", "n3"], 50);
store.withdraw("batch-1");
const out = await store.render(["n1"], async (nodeId, text) => `${nodeId}:${text}`);
```

## 语义

- `publish` 发布不可变正文，返回唯一版本 ID。
- `rollout` 按确定性哈希选人（与输入顺序无关，10/25/50/100 嵌套，向上取整）；
  `batchId` 为幂等键，同参数重试返回原批次，已撤回的批次不会复活。
- 节点有效版本 = 覆盖该节点且未撤回的最后创建批次；否则用基线。
- `render` 调用注入的异步 renderer，不实现模板语言。
