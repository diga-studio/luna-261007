# a11y-table-nav

无障碍表格导航库（TypeScript）：供上层文档阅读器调用，管理单个阅读游标，
支持方向键移动并返回单元格内容与有序的多级行/列表头。表格与游标均保存在进程内存中。

## 构建与测试

```sh
npm install
npm test        # 编译 src 与 test 并运行 node:test 测试
npm run build   # 仅编译库到 dist/
```

## 使用

```ts
import { createTableNavigator } from 'a11y-table-nav';

const nav = createTableNavigator({
  rowCount: 3,
  colCount: 3,
  cells: [
    { id: 'h1', text: '季度', row: 1, col: 2, rowSpan: 1, colSpan: 2, kind: 'col-header' },
    { id: 'r1', text: '北区', row: 2, col: 1, rowSpan: 1, colSpan: 1, kind: 'row-header' },
    { id: 'v1', text: '120', row: 2, col: 2, rowSpan: 1, colSpan: 1, kind: 'data' },
    // ...
  ],
});

nav.locate(2, 2);      // => { cellId: 'v1', text: '120', row: 2, col: 2, headers: [...] }
nav.move('right');     // 保持行号，跳过空洞，落点为进入目标格的第一个坐标
nav.move('down');      // 没有目标时返回 null 并保持原位
```

## 规则摘要

- 坐标从 1 开始；单元格覆盖连续矩形，允许空洞。
- 水平移动保持行号、竖直移动保持列号；从当前单元格对应边缘离开，
  跳过空洞到达该方向最近的单元格；落点是沿路径进入目标格的第一个坐标。
- 表头：单元格可通过 `headers` 给出显式编号序列（保持次序、按编号去重、
  空数组表示不报表头、不递归展开）；未提供时自动关联——
  列区间重叠且整体位于目标上方的全部列表头（按起始行、列升序）在前，
  行区间重叠且整体位于目标左侧的全部行表头（按起始列、行升序）在后。
  自动关联以目标格整个覆盖范围为准，不随格内落点改变。
