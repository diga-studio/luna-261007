# terrasight-mvt

TerraSight 离线面要素瓦片编码库：将已完成投影与坐标量化的 Polygon /
MultiPolygon 要素裁剪到瓦片矩形并编码为 MVT 2.1（Mapbox Vector Tile）。

裁剪保证面积精确：解码后每个要素覆盖的平面区域等于原要素与瓦片矩形的交集
（忽略仅有线或点的交集），不会填上洞、连接原本分离的区域或丢失有面积的片段。

## 输入约定

- 坐标为全局整数，+x 向右、+y 向下，所有边平行于坐标轴。
- 环闭合且简单，方向任意；洞严格位于所属外环内，同一要素各环不接触。
- 每个要素包含唯一 `id` 与 GeoJSON Polygon/MultiPolygon 结构的 `geometry`。

## API

```ts
import { createSource, encodeTile } from 'terrasight-mvt';

const source = createSource(features);          // 只读要素源
const bytes: Uint8Array = encodeTile(source, tileX, tileY); // MVT 2.1
```

瓦片 `tileX/tileY` 对应全局矩形：左上角 `(tileX*4096, tileY*4096)`，宽高 4096。
编码时坐标仅平移为瓦片局部坐标，不缩放。每个有面积交集的输入要素恰好对应一个
Polygon 类型的 MVT Feature（保留原 `id`），裁剪出的多个面属于同一个 Feature。

## 实现要点

- `src/clip.ts`：以全部顶点坐标与瓦片边界构建网格，对网格单元中心做精确
  （倍长整数）奇偶包含测试，再沿内部单元边界追踪环。在区域仅以点相接的
  顶点处按固定规则配对边，保证输出环简单、不串成自交环。
- `src/mvt.ts`：手写 protobuf 与 MVT 2.1 几何命令流（MoveTo/LineTo/ClosePath，
  zigzag 差分编码），外环顺时针、洞环逆时针。
- 无运行时依赖；仅 devDependency `typescript`。

## 构建与测试

```sh
npm install
npm test
```

测试使用 Node 内置 `node:test`，包含独立的 MVT 解码器，核对区域面积、
内部点归属、环简单性，以及环方向/起点变换下的输出不变性。
