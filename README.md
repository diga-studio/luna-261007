# ForgeLink 单管线事件时间窗口聚合器

TypeScript 实现的进程内内存库，供实时采样与历史追补共用同一条聚合管线。
输入视为已完成字段映射、类型转换和行过滤，只聚合一个数值字段；调用按顺序执行，无持久化。

## 接口

```ts
import { WindowAggregator } from './src/aggregator';

const agg = new WindowAggregator();
agg.upsertBatch(records); // 至多 5000 条 { recordId, revision, eventTimeMs, value }
agg.query(endMs);         // { count, mean, min, max }，窗口 (endMs - 3_600_000, endMs]
```

- 同一 `recordId` 只保留最高 `revision`；较低或重复版本不改变状态。
- 更正（更高 `revision`）会把该记录的贡献从旧 `(eventTimeMs, value)` 迁移到新值，
  被覆盖的 min/max 不会残留。
- 空窗口返回 `{ count: 0, mean: null, min: null, max: null }`；`mean = sum / count`，不做整数舍入。
- 查询不封存结果：同一 `endMs` 在后续追补后再次查询会得到新结果。

## 实现结构

- `src/aggregator.ts` — `WindowAggregator`：`Map<recordId, 生效记录>` 做版本裁决，
  并把生效记录的贡献写入/移出索引。
- `src/treap.ts` — 以 `(eventTimeMs, recordId)` 为键的随机 treap，每条生效记录一个节点。
  节点维护子树增广信息：`count`、`sum`、`min`、`max`（value 维度）以及子树时间范围
  `minTime`/`maxTime`。

## 复杂度

设 `n` 为当前不同 `recordId` 数量（≤ 50 万），`b` 为批次大小（≤ 5000）。

- **写入 `upsertBatch`**：每条记录一次 Map 查找，加上至多一次 treap 删除和一次插入，
  单次期望 `O(log n)`，整批期望 `O(b log n)`。小批次不遍历、不排序、不复制既有记录。
- **查询 `query(endMs)`**：treap 上做区间聚合。递归时若子树时间范围完全落在
  `(endMs - 3_600_000, endMs]` 内则直接取预聚合值，完全在外则剪枝，只有跨越边界的
  路径继续下探，期望 `O(log n)`，与窗口内记录数无关——即使绝大多数记录落在同一窗口，
  也不会逐条扫描。
- **存储量**：`O(n)`。每个不同 `recordId` 只存一条最高版本记录（Map 项 + 一个 treap 节点），
  不保留历史版本，不按窗口展开记录，不预生成任何终点的结果。
- **数值精度**：`sum` 上界约 `5×10^11`（50 万 × 10^6），远在 `2^53` 之内，整数求和精确；
  `mean` 为一次浮点除法。

## 测试

```bash
npm install
npm test
```

- `test/boundaries.test.ts` — 左右开闭边界、多 recordId 共享时间戳、乱序/重复/过期版本、
  极值记录更正后跨窗口边界迁移并复核四项统计、非法输入与超大批次拒绝。
- `test/randomized.test.ts` — 固定种子（mulberry32）的 4000 步混合序列（新增、重复、
  过期版本、更正、任意终点查询），每步与独立朴素模型逐次核对 count/mean/min/max。
- `test/scale.test.ts` — 实际写入 50 万个不同 recordId（40 万单调时间戳 + 10 万同时间戳），
  共 10 万次查询，其中 5 万次与小批次更正交错；所有期望统计由闭式簿记推导
  （count/sum 增量维护、极值由保留记录钉住），覆盖全量窗口、移出记录窗口与空窗口。
