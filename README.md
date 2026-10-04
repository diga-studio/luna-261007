# body-signature-detector

请求正文签名检测库（TypeScript），供上层 WAF 调用。规则与检测状态全部保存在内存中；
正文的传输解码（chunked、gzip 等）由调用方完成，本库只接收解码后的字节。

## 用法

```ts
import { SignatureRuleSet } from "body-signature-detector";

const rules = new SignatureRuleSet();
rules.addRule({ id: "sig-1", pattern: "^a.*b$" });
rules.addRule({ id: "sig-2", pattern: "eval\\x28" });

const detection = rules.createDetection(); // 每次正文检测相互独立
detection.push(chunk1);                    // Uint8Array，可连续提交任意分块
detection.push(chunk2);                    // 空块是 no-op
const hitIds: string[] = detection.end();  // 声明正文结束，返回命中的规则 id（去重）
```

## 模式语法

- 普通可打印 ASCII 字面量；元字符用 `\` 转义（`\.` `\(` `\|` 等）
- `\xHH` 匹配任意字节（0x00–0xFF）；另有 `\n` `\r` `\t` `\f` `\v` `\0`
- `.` 匹配任意字节（包括换行）
- `[...]` 字符类，支持范围 `[a-z]` 与取反 `[^...]`（相对全部 256 字节取反）
- `|` 分支、`(...)` 分组（只影响语义，不产生捕获）、`*` `+` `?` 量词，可任意嵌套
- `^` / `$` 零宽断言：整份正文的绝对起点 / 终点，与分块、换行无关
- 空模式、空分支、空分组合法；可空重复按空串语义处理

匹配为“存在一次完整匹配”的搜索语义，不要求覆盖整份正文；匹配可跨任意多个块。
只有调用 `end()` 后才认定正文终点（最后一个非空块不代表结束）。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试（含与独立 RegExp 参照的随机差分测试）
```
