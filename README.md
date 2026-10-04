# terrasight-mvt

TerraSight 离线面要素瓦片编码库：将已完成投影与坐标量化的 Polygon/MultiPolygon
要素裁剪到 4096×4096 的瓦片矩形，并输出符合 MVT 2.1 的字节流。裁剪是精确的：
输出要素覆盖的平面区域等于原要素与瓦片矩形的交集（忽略仅有线或点的交集），
不会填洞、不会连接分离区域、不会丢失有面积的片段。

## 用法

```ts
import { createSource, encodeTile } from './src/index.ts';

const source = createSource([
  { id: 1, geometry: { type: 'Polygon', coordinates: [/* rings */] } },
]);
const bytes: Uint8Array = encodeTile(source, 0, 0); // MVT 2.1, extent 4096
```

坐标为全局整数（x 向右、y 向下），瓦片 (tileX, tileY) 对应左上角
(tileX*4096, tileY*4096)、边长 4096 的矩形；编码时仅平移为瓦片局部坐标，不缩放。

## 实现要点

- 裁剪：收集要素全部边线坐标与瓦片边界构成网格，用网格单元中心点做奇偶包含
  判定（倍坐标保持整数精确），再提取已填充单元并集的边界环。
- 环提取：边界边按统一方向发出；在自接触顶点（对角单元对）按固定转向配对，
  保证输出的环简单、面积非零，仅点接触的部分不会被串成自交环。
- 环方向：按嵌套深度确定内外环，偶数深度为外环（y 向下坐标系中顺时针，
  shoelace 面积为正），符合 MVT 2.1 的 winding 约定。
- 每个有面积交集的输入要素恰好输出一个 Polygon 类型的 MVT Feature，保留原 id。

## 脚本

- `npm install` — 安装开发依赖（仅 typescript）
- `npm test` — 运行测试（Node >= 22.18，使用内置 test runner 与原生类型擦除）
- `npm run build` — 编译到 dist/
- `npm run check` — 对 src、test、helpers 做类型检查
