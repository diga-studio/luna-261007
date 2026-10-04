# edge-inference-latency

边缘推理时延分析库（TypeScript）。从本地文件导入一条流水线的历史指标，建立只读数据集，供上层反复做精确统计查询。无接口层，直接以库形式调用。

## 环境

- Node.js >= 22.6（测试直接以 TypeScript 运行，依赖 Node 内置类型擦除与 `node:test`）
- `npm install` 后 `npm test` 即可运行全部测试（含规模验收）；`npm run typecheck` 做类型检查

## 输入文件格式

CSV，每行一条指标：

```
deviceId,timestampMs,latencyUs
gw-1,1700000000000,120
gw-2,1700000000500,9999999
```

- `timestampMs`：整数毫秒时间戳，可重复、顺序任意；完全相同的行也代表不同推理，分别计数
- `latencyUs`：整数微秒，范围 `0..10_000_000`
- `deviceId`：可包含逗号以外的任意字符（解析从行尾向前取两个逗号分隔）
- 允许一个可选表头行（首行时间戳/时延字段非整数时视为表头）与空行；其余畸形行、越界时延会使导入报错

## API

```ts
import { importMetrics } from 'edge-inference-latency';

const ds = await importMetrics('/path/to/metrics.csv');

// 全部设备（每条推理等权，不按设备等权）
const all = ds.query({ startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 });

// 单台设备
const one = ds.query({ startMs: 0, endMs: 1_700_000_600_000, deviceId: 'gw-1' });
// => { count, throughputPerSec, p50, p95, p99 }
```

- 查询范围为左闭右开 `[startMs, endMs)`，边界为任意整数毫秒，不做取整；`startMs >= endMs` 或非整数会抛错；未知设备标识抛错
- `throughputPerSec = count / ((endMs - startMs) / 1000)`，区间内无上报的时间照常计入分母
- 分位精确：匹配 N 条记录按时延升序后，p50/p95/p99 取第 `ceil(N * 0.50 / 0.95 / 0.99)` 个（从 1 计，重复值各占位）
- 无匹配记录时 `{ count: 0, throughputPerSec: 0, p50: null, p95: null, p99: null }`
- 每次 `importMetrics` 产生独立的只读 `Dataset`，查询期间数据不变

## 设计

- 导入：流式逐行解析（避免整文件字符串的内存峰值），按设备分桶后按 `(设备, 时间戳)` 排序，得到全局有序的时间戳数组与时延数组
- 查询：每台设备的时间片用二分定位（毫秒级边界精确）；时延上建 24 层 wavelet matrix（`2^24 > 10_000_000`），跨设备分位通过对所有命中区间同步下潜做精确第 k 小选择，复杂度 `O(24 × 设备数)`，无需物化或重排匹配记录
- 内存：2M 条记录下数据集约几十 MB（时间戳 Float64、时延 Uint32、每层位图与 rank 前缀和）

## 规模验收（npm test 中的 scale 用例实测）

- 2,000,000 条记录、128 台设备（Zipf 倾斜）、时延高度分散
- 导入约 4s（预算 60s）；2000 次各覆盖 50%–90% 记录的全设备查询共约 0.3s（预算 5s），单次 p95 约 0.2ms（预算 10ms）；峰值 rss 约 0.5GiB（预算 1GiB）
- 同用例内含对暴力扫描的精确性抽查
