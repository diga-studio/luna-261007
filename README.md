# a11y-table-nav

无障碍表格导航库：供上层文档阅读器调用，支持盲人用户通过方向键阅读报表，
朗读单元格内容的同时给出对应的多级行/列表头。表格与阅读游标均保存在进程内存中。

## 构建与测试

```sh
npm install
npm test        # 先 tsc 构建，再用 node:test 运行全部测试
```

仅需 Node.js 与 npm；无 Docker、数据库等外部服务依赖。

## 使用

```ts
import { TableReader } from "a11y-table-nav";

const reader = new TableReader({
  rowCount: 3,
  colCount: 3,
  cells: [
    { id: "h1", text: "季度", kind: "colHeader", row: 1, col: 2, rowSpan: 1, colSpan: 2 },
    { id: "r1", text: "北区", kind: "rowHeader", row: 2, col: 1, rowSpan: 2, colSpan: 1 },
    { id: "d1", text: "12",  kind: "data",      row: 2, col: 2, rowSpan: 1, colSpan: 1 },
    // 坐标从 1 开始；可选 headerIds 显式指定表头（空数组 = 不报表头）
  ],
});

reader.locate({ row: 2, col: 2 });   // 定位到任意被覆盖坐标
const res = reader.move("right");    // 上/下/左/右移动
// res = { moved, cellId, text, position, headers }
// position 是沿移动路径进入目标格的第一个坐标；headers 为有序表头文本
```

## 规则摘要

- 水平移动保持行号、竖直移动保持列号；从当前单元格对应边缘离开，
  跳过空洞到达该方向最近的单元格；无目标时保持原位。
- 显式 `headerIds` 优先：保持给定次序、按编号去重、不递归展开；
  未提供时自动关联——列区间重叠且整体在上方的列表头（按起始行、列升序）+
  行区间重叠且整体在左侧的行表头（按起始列、行升序）。
