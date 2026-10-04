# funnel-merge-stats

线索归并后的增量漏斗统计库（纯进程内计算，TypeScript）。

调用者负责查重并通过 `merge` 告知归并关系；本库只保证归并后的
按渠道、按日 captured/converted 统计始终准确，所有操作返回后即可查询。

## 使用

```ts
import { FunnelStats } from "funnel-merge-stats";

const f = new FunnelStats();
f.add("A", "X", 5);   // 新增未转化线索：id 全局唯一，flowId 渠道，day 为 UTC 日序号
f.convert("A");       // 转化 id 当前所属整组；重复调用无影响
f.merge("A", "B");    // 归并两 id 所属整组；同组无影响；转化状态取逻辑或
const r = f.report("X", 0, 100); // 闭区间按日统计
```

`report` 返回 `{ flowId, fromDay, toDay, days, totalCaptured, totalConverted }`，
其中 `days` 只列有贡献的日期（缺失日期视为零），按日升序。

## 语义

- 每个逻辑客户在它的每个 flowId 上恰好贡献一次 `captured`，
  归入该客户在该渠道上的最早 day；若已转化，同位置再贡献一次 `converted`。
- 归并可能让旧日期计数减少、较早日期计数增加，并让另一渠道首次出现转化贡献。
- 任何历史 id 永久有效；`convert`/`merge` 作用于 id 当前所属整组。
- 统计结果与归并顺序、`merge` 参数方向无关。

## 实现要点

- 并查集（按权重合并 + 路径压缩）维护分组，根节点保存
  `converted` 标志与 `flowId -> 最早 day` 表，不保存成员列表。
- `merge` 只扫描渠道数较少一方的渠道表，增量调整全局计数；
  单条线索并入大组为 O(1)，累计不退化为平方级。
- 每个 flowId 的按日计数用有序槽位 + 懒前缀和维护，
  `report` 只需两次二分，不扫描线索成员或其他渠道。

## 构建与测试

```sh
npm install
npm test
```

只依赖 `typescript` 与 `@types/node`（均为 devDependencies），
测试使用 Node 内置 test runner，无需任何外部服务。
