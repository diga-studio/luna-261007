# CinemaDesk 导出规划库

非破坏性剪辑的导出规划库（TypeScript）。只处理元数据，不读取或编码媒体。
全程使用 BigInt 有理数运算，不展开虚拟时间线，规划开销与请求帧数无关。

## 用法

```ts
import { build, duration, planExport } from './src';

const timeline = build(recordings, edl, rootId);
const { num, den } = duration(timeline);            // 精确秒数（约分后的分子/分母）
const page = planExport(timeline, 30, '0', '1000'); // 最多 128 个 span + nextFrame
```

- `recordings`：`{ id, fps: 24|30|60, segments: [{ id, frameCount }] }`，有效段依次相接。
- `edl`：按依赖顺序排列的节点（≤500），`source` / `trim`（微秒区间 `[startUs, endUs)`）/ `concat`。
- `planExport` 返回的每个 span：`{ startFrame, frameCount, recordingId, segmentId, a, b, d }`，
  span 内第 `j` 帧的源帧为 `floor((a + j*b) / d)`，`gcd(a,b,d)=1`。
- `nextFrame` 为续查起点；无需续查时为 `null`。

## 构建与测试

```sh
npm install
npm test
```
