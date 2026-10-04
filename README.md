# edge-inference-latency-analyzer

边缘推理时延分析库（TypeScript）。面向工业数据工程师：比较同一条流水线在不同网关上的推理表现，通过不断调整时间范围定位长尾延迟。

上层直接以库的方式调用，无接口层。原始指标存本地文件，导入后得到独立的只读数据集，可反复查询。

## 安装与测试

```bash
npm install
npm test        # 编译并运行全部自动化测试（含规模验收）
npm run build   # 仅编译到 dist/
```

只依赖 Node.js（建议 20+）与 devDependencies 中的 typescript / @types/node，无运行时依赖，不需要数据库、缓存或任何服务进程。

## 指标文件格式

本地 CSV 文件，无表头，每行一条记录：

```
deviceId,timestampMs,latencyUs
```

- `deviceId`：设备标识，非空字符串（不含逗号）
- `timestampMs`：整数毫秒时间戳，顺序任意，可以重复
- `latencyUs`：整数微秒时延，范围 0–10000000

所有字段完全相同的行也代表不同的推理，分别计数。空行被忽略。

## API

```ts
import { importMetricsFromFile } from 'edge-inference-latency-analyzer';

const dataset = importMetricsFromFile('/path/to/metrics.csv');

// 全部设备，[startMs, endMs)，边界为任意整数毫秒，不做取整扩张
const all = dataset.query({ startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 });
// 单台设备
const one = dataset.query({ startMs: 0, endMs: 60_000, deviceId: 'gw-01' });
```

`query` 返回：

| 字段 | 含义 |
| --- | --- |
| `count` | 匹配记录数 |
| `throughputPerSec` | 每秒推理次数 = `count / 区间秒数`（区间内无上报的时间也计入分母） |
| `p50` / `p95` / `p99` | 精确分位（微秒）；无匹配记录时为 `null` |

分位定义：匹配 N 条记录按时延升序排列，p50/p95/p99 分别取第 `ceil(N*0.50)`、`ceil(N*0.95)`、`ceil(N*0.99)` 个位置（从 1 开始），重复值分别占位。跨设备查询中每条推理权重相同，不按设备等权。无匹配记录时 `count` 与 `throughputPerSec` 为 0，三个分位为 `null`。

每次 `importMetricsFromFile` 建立独立的只读数据集；查询期间数据不变。`startMs >= endMs` 或非整数边界会抛出 `RangeError`。

## 实现要点

- 全设备查询：所有记录按时间戳排序后建立归并排序树（merge sort tree），任意时间范围内「≤v 计数」与「第 k 小值」均为 O(log²N)，分位通过对时延值域二分得到，结果精确。
- 单设备查询：每台设备独立的时间有序数组，范围内切片排序后取位。
- 记录数 = 时间戳二分上下界之差，吞吐率直接由记录数与区间秒数相除。
- 解析按字符扫描，不物化整行字符串，控制导入峰值内存。

## 规模验收（test/scale.test.ts）

200 万条记录、128 台设备（记录量几何级倾斜）、时延高度分散：

- 完整导入 < 60 秒，导入及查询峰值内存 < 1 GiB
- 2000 次覆盖 50%–90% 记录的全设备查询总耗时 < 5 秒，单次 p95 < 10 毫秒
- 抽样与暴力法逐条比对，验证精确结果

本机实测：导入约 1.1 秒，2000 次查询共约 0.15 秒，单次 p95 约 0.1 毫秒，峰值 RSS 约 0.58 GiB。
