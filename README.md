# task26100771

端点库存导入前的身份对账组件（只读，不修改库存）。

## 使用

```ts
import { createReconciler } from "./src/reconciler";

const reconciler = createReconciler(existingInventory); // 只读快照，可复用
const conclusions = reconciler.reconcile(importRows);
// 每行结论：matched（确定关联）/ new（确定新增）/ ambiguous（身份歧义，
// 附完整 possibleEndpointIds 与 canBeUnmatched）
```

## 语义

- 候选关联：agentToken 相同为 token 级；否则 hostname+site 相同为
  hostname 级；否则 ip+site 相同为 IP 级。导入行提供的 agentToken 与
  库存不同则禁止关联。
- 全局目标按 (token 数, hostname 数, IP 数) 字典序最大化，通过足够大的
  分层权重（base²/base/1）在最大权二分匹配中精确实现，不做额外平局打破。
- 每行的结论在**全部**最优配对上精确计算：强制关联/强制不关联后重解，
  与最优值比较得出可能端点集合与是否可不匹配。

## 构建与测试

```sh
npm install
npm test
```
