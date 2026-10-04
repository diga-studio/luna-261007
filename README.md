# spherical-geofence-matcher

位置营销使用的球面围栏匹配库。围栏目录保存在进程内存中，由上层直接调用，无接口层。

## 环境要求

- Node.js >= 22.18（利用原生 TypeScript 类型擦除运行 `.ts` 测试，推荐 24.x）
- `npm install` 后 `npm test` 即可运行全部测试；`npm run build` 做类型检查

## API

```ts
import { GeoFenceCatalog, type FenceInput } from "./src/index.ts";

interface FenceInput {
  id: string;          // 唯一标识，非空字符串
  centerLat: number;   // [-90, 90]
  centerLon: number;   // [-180, 180]，180 与 -180 为同一经线
  radiusMeters: number; // [50, 5000]
}

const catalog = new GeoFenceCatalog();
catalog.loadAll(fences);   // 整体载入，替换此前目录
catalog.upsert(fences);    // 按标识批量新增或修改（移动中心 / 调整半径）
catalog.remove(ids);       // 按标识批量删除，标识之后可复用
catalog.match(lat, lon);   // 返回覆盖该位置的全部围栏标识（string[]），不重不漏
catalog.size;              // 当前围栏数量
```

- 非法输入（纬度 / 经度 / 半径越界、空标识）会抛出异常。
- 同一批次内出现重复标识时，后出现的覆盖先出现的。
- 所有修改在下一次 `match` 调用时立即生效。

## 匹配语义

- 地球按半径 6371008.8m 的球体处理，距离为球面最短弧长。
- 设备与围栏中心的距离不超过 `radiusMeters + 0.001`（1mm 向外容差）即命中。
- 跨日界线、覆盖极点的围栏同样适用该容差；极点上所有经度视为同一点。

## 实现要点

- 每个围栏中心映射为地心直角坐标系中的单位向量，按 500m 三维网格分桶。
- 查询时取查询点向量的主轴，在垂直于主轴的二维网格列上枚举与球面
  相交的网格（球壳裁剪），只扫描候选围栏。
- 命中判定用预计算的单位向量点积：`dot >= cos((radius + 0.001) / R)`，
  与 haversine 弧长判定等价，避免每次查询做三角运算。
- 围栏的增删改通过槽位回收与桶内交换删除实现 O(1) 更新。

## 规模实测（本机，Node v24.11.1）

20 万围栏 + 2 万次查询 + 穿插 2000 次单条增 / 改 / 删（不计首次载入）：

| 场景 | 耗时 | 预算 |
| --- | --- | --- |
| 全球分散分布（50m / 5000m 半径混合） | ~2.3s | 30s |
| 北纬 89.9° 以北集中分布（50m / 5000m 半径混合） | ~5.3s | 30s |

计时结束后每个场景再抽样 200 个查询与逐围栏 haversine 暴力结果逐一核对，
全部一致。正确性测试另覆盖跨日界线、南北极点、1mm 边界容差、多重重叠、
跨日界线移动、半径伸缩、删除后复用标识等场景。
