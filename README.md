# pixelgrid-csv-import

PixelGrid CSV 导入判型库（TypeScript）。输入异步 UTF-8 字节流，
自动判定列类型并逐行交付转换后的记录。本模块不持久化数据，
由上层直接调用，无接口层。

## 用法

```ts
import { importCsv } from 'pixelgrid-csv-import';

// source：任意 AsyncIterable<Uint8Array>，单块不超过 64 KiB，
// 分块可落在任意字节位置（多字节字符中间亦可）。
for await (const event of importCsv(source)) {
  if (event.kind === 'meta') {
    // 列类型确定后交付一次：表头与每列类型。
    console.log(event.header, event.types);
  } else {
    // 每条数据记录一个事件：转换后的单元格与本行警告。
    console.log(event.index, event.cells, event.warnings);
  }
}
```

## 规则摘要

- 首条逻辑记录为表头，不参与判型；采样前 100 条数据记录
  （全空记录占名额），不足 100 条取全部。
- 每列以非空样本数为分母，命中比例 ≥ 80% 的非 text 类型有资格，
  按 boolean → integer → float → date → url → email 取第一个，
  否则为 text；全空列为 text。
- 空值（解码后空字符串）输出 `null`；boolean/integer/float 输出
  相应 JavaScript 值；其余类型保持原文。采样后出现的无法转换的
  非空单元格保留原文并产生警告（含记录号与列号），不丢行。
- 获得第 100 条完整数据记录后立即交付 meta 与采样记录；
  调用方暂停消费时，额外读取不超过一个输入块（≤ 64 KiB）。

## 构建与测试

```sh
npm install
npm test
```

依赖仅为开发期 TypeScript（`typescript`、`@types/node`），
测试使用 Node.js 内置 `node:test`，无需任何服务。
