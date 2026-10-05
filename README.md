# ambiguous-reconciliation

交易与借贷账项的歧义对账组件（进程内 TypeScript 库）。

上游提供交易 ID 集合、账项组 ID 集合与候选配对。基准配对数 K 是初始候选关系
能实现的最大一一配对数量；最优方案是包含全部已接受人工裁定且配对数等于 K
的方案。组件回答：哪些配对是确定的（出现在所有最优方案中）、哪些是可能的
（出现在至少一个最优方案中）、哪些 ID 可能落单。

## 接口

- `create(transactionIds, journalIds, candidatePairs)`：建立不可变候选快照，返回独立会话。
- `analyze(session)`：返回 `{ k, certainPairs, possiblePairs, possiblyUnmatchedTransactionIds, possiblyUnmatchedJournalIds }`。
- `resolve(session, pairs)`：追加一批人工固定配对。仅当全部旧裁定与新裁定能
  共同包含在某个最优方案中时接受，否则整批拒绝且会话不变。

## 构建与测试

```sh
npm install
npm test
```
