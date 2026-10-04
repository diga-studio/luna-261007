# body-signature-detector

一个供上层 WAF 调用的请求正文签名检测库。规则与检测状态全部保存在内存中；
正文的传输解码（chunked、gzip 等）由调用方完成，本库只接收解码后的字节流。

## 特性

- 流式检测：连续提交任意大小的字节块，切分方式不影响结果，空块不改变状态。
- 每条规则包含唯一 ID 与模式；一次检测结束后返回所有命中规则的 ID 集合（每条规则只出现一次）。
- 不同检测（Inspection）之间状态完全独立。
- 匹配按字节区分大小写，字节取值 0–255。
- 基于 Thompson NFA 模拟，匹配耗时与正文长度成线性关系，不存在回溯爆炸。

## 模式语法

| 结构 | 说明 |
| --- | --- |
| 普通可打印 ASCII | 字面量字节 |
| `\` + 元字符 | 转义字面量，如 `\.`、`\|`、`\\` |
| `\xHH` | 任意字节（0x00–0xFF） |
| `.` | 任意字节，包括换行 |
| 拼接 | 直接相连 |
| `a\|b` | 分支 |
| `(...)` | 分组（仅影响语义，不产生捕获） |
| `[abc]`、`[a-z]`、`[^...]` | 字符类、范围、取反（相对全部 256 字节取反） |
| `*`、`+`、`?` | 量词，可作用于任意原子（含分组） |
| `^`、`$` | 整份正文的绝对起点 / 终点（零宽，与块边界、换行无关） |

以上结构可任意合法嵌套。空模式、空分支、空分组均合法；可空重复按空串语义处理。
默认在正文任意位置寻找匹配，只要求存在一次完整匹配。只有调用方调用 `end()`
明确声明正文结束后，`$` 才被认定。

## 使用

```ts
import { RuleSet } from 'body-signature-detector';

const rules = new RuleSet();
rules.addRule('sig-1', '^a.*b$');
rules.addRule('sig-2', '\\x00\\x01|evil');

const inspection = rules.createInspection();
inspection.submit(chunk1); // Uint8Array，解码后的字节块
inspection.submit(chunk2);
const hits: Set<string> = inspection.end(); // 命中规则 ID 集合
```

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>=18）与 devDependencies 中的 `typescript`、`@types/node`；
测试使用 Node 内置 test runner，并以 V8 RegExp 作为独立参考实现做差分校验。
