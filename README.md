# dns-zone-diff

DNS 快照规范化与差分库（TypeScript），供域名资产变更审计调用。不做快照存储。

## API

- `normalizeZone(origin, text): ZoneRecord[]` — 解析主文件文本，返回去重、顺序确定的规范记录（owner 为绝对小写名、TTL 为秒、RDATA 为结构化规范形式）。相同语义的输入得到逐字段相同的结果。
- `diffZones(origin, before, after): { added, removed }` — 返回新增与删除的规范记录集合。TTL 变化表现为删除旧记录 + 新增新记录；重复记录数量不影响结果。
- 任一输入存在解析错误（未闭合引号/括号、越界转义等）时抛出 `ZoneParseError`，不返回部分结果。

## 支持的输入子集

- 记录类型：A、AAAA、CNAME、MX、TXT、NS；仅 IN 类。
- 指令：`$ORIGIN`（相对值按旧 origin 展开）、`$TTL`。
- 名称：尾点绝对名、相对名、`@`，大小写不敏感；首行前导空白沿用上一条记录已展开的 owner。
- TTL：十进制秒或 `w/d/h/m/s` 单位组合（大小写不敏感）；省略时使用当时的 `$TTL` 默认值。
- 语法：引号外 `;` 行注释、括号合并多行、LF/CRLF；TXT 为一个或多个双引号片段，支持 `\DDD` 十进制字节转义，每片段解码后不超过 255 字节。

## 比较语义

- A 按四个十进制字节、AAAA 按 128 位值比较；MX 优先级参与比较。
- TXT 按有序字节片段比较（大小写敏感），`"ab" "c"` ≠ `"a" "bc"`，不做片段拼接。

## 构建与测试

```sh
npm install
npm test        # 编译并运行 node:test 测试
npm run build   # 仅编译到 dist/
```
