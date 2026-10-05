# task26100774

DataForge 模糊重复聚类库（TypeScript）。输入记录只含唯一 `id` 与长度 8–32 的小写字母串 `value`，组件负责相似度计算与重复聚类。

## API

- `similarity(a, b)`：单位代价 Levenshtein 距离 `d`（仅插入/删除/替换），返回 `1 - d / max(len(a), len(b))`。
- `cluster(records)`：返回 `{ clusters, stats }`。`clusters` 是相似图的连通分量（只含 ≥2 个 id 的簇），相似边定义为 `10 * d <= max(len)`（即 similarity ≥ 0.9 的精确整数边界）；`stats.distanceChecks` 统计候选检索后发生的全部距离判定（含提前终止）。

## 实现要点

- 相同 value 先合并（零距离计算），每个不同 value 只保留一个代表参与模糊匹配。
- 候选检索使用鸽巢原理的精确 g-gram 过滤：若 `d(s,t) <= k`，两串必共享长度 `ceil((minLen-k)/(k+1))` 的公共子串。每条串按长度对应的 gram 长度入倒排索引，查询时探测所有可行配对长度所需的 gram 长度，保证不漏任何达阈值的对（非近似召回）。
- 候选对用带提前终止的带宽 Levenshtein 验证，并查集合并，输出连通分量；结果与输入顺序无关。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 先编译（`tsc`）再运行 `node --test`，包含 10 万条记录的规模测试（`stats.distanceChecks` 远低于 200 万上限）。
