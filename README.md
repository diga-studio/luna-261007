# task26100794

CinemaDesk 非破坏性剪辑导出规划库（TypeScript）。只处理元数据，不读取、不编码媒体；
全程使用 BigInt 有理数运算，无浮点近似。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

## API

```ts
import { build, duration, plan } from 'cinemadesk-planner';
```

- `build(recordings, edl, rootId)` — 由录制元数据与 EDL（source / trim / concat，
  按依赖顺序，可重复引用节点）建立可查询时间线。
- `duration(timeline)` — 精确总时长，返回约分后的 `{ num, den }` 秒数字符串。
- `plan(timeline, fps, firstFrame, frameCount)` — 规划输出帧区间，返回
  `{ spans, nextFrame }`。每次最多 128 个 span；`nextFrame` 为续查起点，
  无需续查时为 `null`。

span 内第 `j` 帧的源帧为 `floor((a + j*b) / d)`，`d > 0` 且 `gcd(a,b,d) = 1`。
输出帧 `k` 的采样时刻为 `k/fps` 秒（根时间线零点为原点），只采样严格早于
总时长的时刻；片段边界属于右侧片段。

## 实现要点

- 时间线按 EDL 编译为共享子树（重复引用只编译一次），concat 记录子节点
  前缀和；定位任意时刻为一次自根向下的二分下降，不展开虚拟时间线，
  不扫描查询起点之前的片段。
- 规划从查询起点所在的片段向前逐片段推进，每个含采样帧的片段出现产生
  恰好一个 span；规划开销与请求帧数、虚拟时长无关。
- 所有帧数、帧索引、微秒位置均以十进制字符串出入；内部为约分 BigInt
  有理数，分页不重置采样相位。
