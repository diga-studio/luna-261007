# funnel-merge-stats

线索归并后的增量漏斗统计库（TypeScript，纯进程内计算）。

查重结果由调用者提供：本库不判断两条线索是否相似，只负责让归并后的
按渠道（flowId）、按 UTC 日（day）的 captured / converted 统计始终准确。

## 使用

```ts
import { FunnelStats } from "./src";

const stats = new FunnelStats();
stats.add("lead-1", "flowX", 5);   // 新增未转化线索：id、渠道、UTC 日序号
stats.add("lead-2", "flowX", 2);
stats.convert("lead-1");           // 转化 id 当前所属的整组（幂等）
stats.merge("lead-1", "lead-2");   // 归并两个 id 所属的整组（同组无影响）
stats.report("flowX", 1, 10);
// => [{ day: 1, captured: 0, converted: 0 }, ..., { day: 2, captured: 1, converted: 1 }, ...]
```

- `add(id, flowId, day)`：新增一条未转化的原始线索，`id` 全局唯一。
- `convert(id)`：将 `id` 当前所属的整组标记为已转化；重复调用无额外影响。
- `merge(a, b)`：归并两个 id 所属的整组；已转化状态取逻辑或；任何历史 id 永久有效。
- `report(flowId, fromDay, toDay)`：返回闭区间内按日的 `{ day, captured, converted }`，
  无贡献的日期为零。

## 归因语义

每个逻辑客户在它在归并过程中出现过的每个 flowId 上恰好贡献一次
captured，归入该客户在该 flowId 上的最早 day；若已转化，在相同
(flowId, day) 上再贡献一次 converted。归并可能让较晚日期的计数减少、
较早日期的计数增加，并让另一渠道首次出现转化贡献；所有操作返回后
`report` 立即反映完整结果。

## 实现要点

- 并查集维护逻辑客户分组，每组只保存聚合数据：是否已转化 +
  `flowId -> 最早 day` 的映射（不保存成员列表）。
- 归并按组内不同 flowId 数量决定挂接方向（小组并入大组），单条线索
  反复并入大组时单次归并只扫描小组的渠道表，累计近线性。
- 仅当归并触发"未转化 → 已转化"翻转时，才扫描未转化侧的渠道表；
  每组至多翻转一次。
- 统计表为 `flowId -> (day -> count)` 的增量计数，归并时只做
  O（小组渠道数） 次增减；`report` 只读取目标渠道、目标区间的计数。

## 构建与测试调味

```sh
npm install
npm test        # tsc 编译 + node --test
```

测试包括：题目给定的 A/B/C 场景、与全量重算参考模型逐步核对的随机测试、
归并顺序/参数方向不变性测试，以及 6 万条线索的压力测试。
