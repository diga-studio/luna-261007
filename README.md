# dns-zone-diff

DNS 快照规范化与差分库，供域名资产的变更审计调用。解析 DNS 主文件（zone master file）的限定子集，产出规范记录集合并计算快照间差分。不做快照存储。

## 要求

- Node.js >= 22.18（依赖原生 TypeScript 类型擦除运行 `.ts`，无需构建步骤）
- `npm install` 仅安装可选的 `typescript`（用于 `npm run typecheck`）；`npm test` 不依赖任何第三方包

## 使用

```ts
import { normalizeZone, diffZones } from "dns-zone-diff";

const records = normalizeZone("example.com.", zoneText);
// => ZoneRecord[]：去重、确定顺序；owner 为小写绝对名（尾点），TTL 为秒

const { added, removed } = diffZones("example.com.", beforeText, afterText);
// => 新增与删除的规范记录集合；TTL 变化表现为 删旧 + 增新
```

任一输入存在解析错误（未闭合引号/括号、越界转义等）时，两个操作都整体抛出 `ZoneParseError`，不返回部分结果。

## 支持的输入子集

- 记录类型：A、AAAA、CNAME、MX、TXT、NS；仅 IN 类；仅 ASCII；LF 与 CRLF
- 指令：`$ORIGIN`（相对值按旧 origin 展开）、`$TTL`；其他指令报错
- 名称：尾点绝对名、相对名、`@`；大小写不敏感；不支持转义标签与 IDNA
- 行首空白表示沿用上一条记录已展开的 owner；指令不影响该 owner
- TTL 可省略（取当时的 `$TTL`，缺省未设置则报错）；支持十进制秒与 `w/d/h/m/s` 单位组合（大小写不敏感）
- 引号外未转义的 `;` 开始行注释；引号外括号将多行合为一条记录
- TXT：一个或多个双引号片段；`\DDD` 三位十进制转义（0–255），`\c` 转义任意字符；每片段解码后 ≤ 255 字节

## 规范化语义

- A 按四个十进制字节、AAAA 按 128 位值、MX 含优先级参与比较
- TXT 按有序字节片段比较，大小写敏感；片段边界有意义（`"ab" "c"` ≠ `"a" "bc"`）
- 相同语义（排版、大小写、TTL 单位、IPv6 等价写法、注释、多行、重复记录）得到逐字段相同的结果，差分为空

## 开发

```sh
npm test           # 运行测试（node --test，直接执行 .ts）
npm run typecheck  # 类型检查（需要 npm install 安装 typescript）
```

## 结构

- `src/lexer.ts` — 词法：注释、括号合并多行、引号扫描
- `src/parser.ts` — 语法：指令、owner/TTL/class/type、名称展开
- `src/rdata.ts` — RDATA 解析与规范化（A/AAAA/CNAME/MX/TXT/NS）
- `src/normalize.ts` — `normalizeZone`：规范化、去重、排序
- `src/diff.ts` — `diffZones`：集合差分
