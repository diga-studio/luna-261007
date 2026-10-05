# ambiguous-reconciliation

进程内 TypeScript 库：交易与借贷账项的歧义对账。原始关联编号缺失时，一笔交易可能对应多个账项组；组件在候选配对图上维护"基准配对数 K"与人工裁定，精确回答哪些配对是确定的、哪些配对是可能的、哪些记录可能落单。

## 模型

- 候选关系构成二部图：交易 ID 一侧、账项组 ID 一侧，候选配对为边。
- K = 候选图最大一一配对数，允许两侧存在未配对记录。
- 最优方案 = 包含全部已接受裁定且配对数等于 K 的匹配。
- 人工裁定只缩小可能性，不得降低 K；不满足此条件的批次整批拒绝。

## API

```ts
import { create, analyze, resolve } from "ambiguous-reconciliation";

const session = create(transactionIds, journalIds, candidatePairs); // 不可变快照，独立会话
const r = analyze(session);
// r.k                                基准配对数 K
// r.certainPairs                     出现在所有最优方案中的配对（含已接受裁定）
// r.possiblePairs                    出现在至少一个最优方案中的配对
// r.possiblyUnmatchedTransactionIds  在至少一个最优方案中未配对的交易 ID
// r.possiblyUnmatchedJournalIds      在至少一个最优方案中未配对的账项组 ID

const res = resolve(session, pairs); // 全有或全无：不可共同保持 K 则会话不变
```

判定语义（对每条候选边 / 每个 ID 精确判定，而非启发式）：

- 确定配对：删除该边后剩余图的最大匹配低于 K（即所有最优方案都经过它）。
- 可能配对：强制该边后仍能达到 K。
- 可能落单：删除该顶点后最大匹配仍等于 K。
- 已接受裁定从图中收缩（端点移除），上述判定在残余图上进行，裁定本身恒为确定配对。

## 构建与测试

```sh
npm install
npm test
```

测试使用 Node 内置 `node:test`，先以 `tsc` 编译再运行；覆盖：

- 小规模随机候选图（含 K 无法覆盖全部记录的情形）与独立穷举逐项核对全部输出，含接受裁定后的连锁重分析；
- 两条端点不冲突、各自可行但合并后无法保持 K 的裁定：整批拒绝且分析结果完全不变，随后接受一条可行裁定引发其他记录确定归属的连锁变化。
