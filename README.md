# ForgeLink 事件时间窗口聚合器

单管线、进程内的事件时间窗口聚合器，实时采样与历史追补共用同一条写入路径。
输入视为已完成字段映射、类型转换与行过滤，只聚合一个数值字段。

## 使用

```ts
import { WindowAggregator } from "./src/aggregator";

const agg = new WindowAggregator();
agg.upsertBatch([
  { recordId: "r1", revision: 0, eventTimeMs: 1_000, value: 42 },
]);
agg.query(2_000); // => { count: 1, mean: 42, min: 42, max: 42 }
```

- `upsertBatch(records)`：至多 5000 条；同一 `recordId` 只保留最高 `revision`，
  较低或重复版本是 no-op；批次内/批次间均可乱序。
- `query(endMs)`：统计事件时间落在 `(endMs - 3_600_000, endMs]` 内、当前有效
  （每个 `recordId` 最高版本）的记录，返回 `{ count, mean, min, max }`；
  空窗口返回 `{ count: 0, mean: null, min: null, max: null }`，`mean` 为浮点不取整。

## 构建与测试

干净机器（仅需 Node.js ≥ 18）：

```sh
npm install
npm test   # tsc 构建 + node:test 运行全部测试
```

## 设计

两个结构，均只保存"当前有效"状态：

1. `live: Map<recordId, { revision, eventTimeMs, value }>` — 每个 `recordId`
   只保留最高版本，用于版本仲裁与更正时定位旧贡献。不保留历史版本。
2. `Treap` — 以 `(eventTimeMs, recordId)` 为键的随机化 treap（笛卡尔树），
   每个子树维护聚合量 `count / sum / min / max`。`recordId` 作为次序决胜键，
   使相同时间戳的不同记录各自独立计数。

更正一条记录 = 从 treap 删除旧键 + 插入新键（O(log n)），旧的最小/最大值
不会残留，因为极值不是缓存的"当前答案"，而是每次查询时从子树聚合量中重新
归并出来的；记录移入/移出任意窗口时其贡献随之迁移，查询也不封存结果。

## 复杂度

设 n = 不同 `recordId` 数量（当前有效记录数），b = 批次大小（≤ 5000）。

- **写入 `upsertBatch`**：O(b · log n)。每条记录一次 Map 查找，更正时外加
  treap 的一删一插；不遍历、不排序、不复制既有记录。
- **查询 `query(endMs)`**：O(log n)。沿 treap 的左右边界各下探一条路径，
  路径之间的完整子树直接用预聚合的 `count/sum/min/max` 整体归并，不逐条
  扫描窗口内记录，也不扫描历史。窗口内记录极多（如 50 万条全在一个窗口）
  时仍为 O(log n)。
- **存储**：O(n)。Map 每 `recordId` 一条、treap 每有效记录一个节点；
  不保留历史版本，不把记录按窗口展开，不预生成任何终点的结果。

## 测试

- `test/aggregator.test.ts` — 左右边界（左开右闭）、共享时间戳多记录、
  乱序/重复/过期版本、更正原极值记录并跨越窗口边界后的四项统计、
  追补改变同一终点再次查询的结果、输入校验。
- `test/model-random.test.ts` — 固定种子（20261007）的 4000 步混合序列
  （新增、重复、过期版本、更正、任意终点查询、时钟前进），每步与独立
  朴素模型（全量扫描）逐项核对。
- `test/perf.test.ts` — 实际写入 50 万个不同 `recordId`（40 万单调时间戳 +
  10 万同时间戳），执行 10 万次查询，其中 5 万次与小批次更正交错；所有
  查询都对可推导的期望（增量维护的 count/sum 与可证明不变的 min/max）或
  抽样朴素模型结果做精确断言。
