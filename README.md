# UrbanSketch 样条空间选取库

进程内存中的样条场景，供上层画布调用：批量装入样条场景，按多边形选区（含孔洞）做相交 / 完全包含选取，并返回中心线落在选区内的参数区间用于高亮。

## 使用

```ts
import { SplineScene } from "urbansketch-spline-select";

const scene = new SplineScene();
scene.loadSplines([
  {
    id: "road-1",
    segments: [
      { p0: { x: 0, y: 0 }, p1: { x: 1, y: 2 }, p2: { x: 3, y: 2 }, p3: { x: 4, y: 0 } },
    ],
  },
]);

const hits = scene.select(
  {
    outer: [ { x: -1, y: -1 }, { x: 5, y: -1 }, { x: 5, y: 5 }, { x: -1, y: 5 } ],
    holes: [],
  },
  "intersect", // 或 "contain"
);
// hits: [{ id: "road-1", intervals: [{ start: 0, end: 1 }] }]
```

- 每条样条由首尾相接的三次贝塞尔段组成；第 i 段对应全局参数 `[i, i+1]`。
- 选区 = 外环内部（含边界）− 孔洞内部（孔洞边界仍属选区）。
- `intersect`：样条上至少一点属于选区；`contain`：样条上所有点属于选区。
- 返回区间按参数递增、已合并；孤立接触点保留为 `start === end`；沿边界重叠与退化点段均保留。

## 构建与测试

```sh
npm install
npm test   # tsc 构建 + node --test
```

## 实现要点

- 曲线相对每条选区边的有向叉积是参数 t 的三次多项式，解析求根（含牛顿精化）得到进出选区的候选参数；与边共线的曲线段单独投影边端点处理。
- 候选参数把 `[0,1]` 切成原子区间/原子点，分别做点属选区判定（边界含内），再合并为最大闭区间；跨段在全局参数上继续合并，连接点只保留一份。

## 性能（本机实测，见 test/perf.test.ts）

2000 条样条 × 8 段、选区 48 边外环 + 两个 8 边孔洞（共 64 边）：

- `select("intersect")`：约 170 ms（命中 2000 条，11686 个区间）
- `select("contain")`：约 160 ms

远低于 5 秒上限（耗时不含场景装入）。
