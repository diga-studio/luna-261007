# pixelgrid-csv-import

PixelGrid CSV 导入判型库（TypeScript）。输入异步 UTF-8 字节流，逐行交付转换结果；
本模块不持久化数据，由上层直接调用，无接口层。

## 用法

```ts
import { createImportSession } from "pixelgrid-csv-import";

// source: AsyncIterable<Uint8Array>，块可落在任意字节边界（单块 ≤ 64 KiB）
const session = await createImportSession(source);

session.header;        // 表头（首条逻辑记录，不参与判型）
const types = await session.types; // 列类型：采样满 100 条或流结束时已就绪

for await (const row of session.rows) {
  row.recordIndex; // 数据逻辑记录序号（0 起，不含表头）
  row.cells;       // 转换后的单元格；空值为 null，无法转换的非空单元格保留原文
  row.warnings;    // 本行警告：{ recordIndex, columnIndex, raw, columnType }
}
```

`createImportSession` 返回时即已完成表头解析与采样判型（最多 100 条数据记录），
因此获得第 100 条完整数据记录后，即使输入暂停，列类型与采样记录也可立即交付；
不足 100 条时在流结束后交付。

## 判型规则

- 采样前 100 条数据逻辑记录（不足取全部，全空记录仍占名额）。
- 每列以非空样本数为分母，命中比例 ≥ 80% 的非 text 类型才有资格；
  依次取 boolean、integer、float、date、url、email 中第一个有资格者，否则 text；
  全空列为 text。空值仅指 CSV 解码后的空字符串。
- 原文不裁剪；首尾含 Unicode White_Space 字符的非空值只能匹配 text。
- boolean：不区分大小写的 `true`/`false`。
- integer：可带正负号的十进制整数字面量，须在 JavaScript 安全整数范围。
- float：十进制整数/小数/e/E 指数，整体可带正负号；整数部分必需，小数点后须有数字，
  指数至少一位；数值必须有限；超安全范围的纯整数字面量不匹配。
- date：严格 `MM/DD/YYYY` 的真实公历日期，年份 0001–9999。
- url：WHATWG 语义，仅 `http://`/`https://` 开头（不区分大小写）且主机非空。
- email：恰好一个 `@`；本地部分为 ASCII 字母数字及 `._%+-`；域名至少两段，
  段内为字母数字与非首尾连字符，末段至少两个字母。
- 类型确定后不再调整；采样记录与后续记录使用相同转换规则。

## CSV 支持

逗号分隔；LF 与 CRLF；双引号字段；`""` 转义双引号；引号内逗号与换行原样保留；
流首可有 UTF-8 BOM；末条记录可无换行。判型与解析结果不随输入分块方式改变。

## 资源约束

- 类型确定后，仅在调用方索取下一行时才继续读取输入；
  调用方暂停消费期间累计额外读取不超过 64 KiB。
- 满规模（1000 条 × 50 列 × 4 KiB 单元格）下库造成的额外峰值内存 ≤ 96 MiB
  （不计调用方保存的输出）。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试（node:test）
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（≥ 21）与开发依赖 typescript、@types/node。
