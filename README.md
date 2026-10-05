# task26100771
# endpoint-reconciler

端点库存导入前的身份对账组件：只生成合并建议，不修改库存。

## 用法

```ts
import { createReconciler } from "./src/reconciler.js";

const reconciler = createReconciler(existingInventory); // 只读快照，可复用
const results = reconciler.reconcile(importRows);
// 每行结论：matched（确定关联）/ added（确定新增）/ ambiguous（身份歧义）
```

关联证据分级：token > hostname(+site) > ip(+site)。全局按
(token 数, hostname 数, ip 数) 字典序最大化；每行的结论基于**全部**
最优配对计算：可能关联端点集合 + 是否可能在最优配对中不匹配。

## 构建与测试

```sh
npm install
npm test
```
