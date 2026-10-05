# ContentHub 关键词审核库

ContentHub 内容保存流程直接调用的关键词审核库。词库保存在本地 JSON 文件；
待审文本与审核结果不持久化。

## 安装与测试

```bash
npm install
npm test        # 运行全部自动化测试（vitest）
npm run build   # 编译到 dist/
```

只依赖 Node.js，devDependencies（typescript、vitest、@types/node）均在
package.json 中声明。

## 用法

```ts
import { KeywordReviewer } from "contenthub-keyword-review";

// 词库文件：JSON 数组，每项 {"id": number | string, "word": string}
const reviewer = KeywordReviewer.loadFromFile("./wordlist.json");
// 或直接构造：new KeywordReviewer([{ id: 1, word: "禁词" }])

const result = reviewer.review("待审的纯文本字段");
// result.blocked: boolean —— 有任何命中即为 true
// result.hits: [{ id, start, end }] —— 每个命中编号最早的一处，
//              按原文起点排序，可直接用于编辑器高亮
```

- 输入是已提取好的纯文本，不负责解析富文本。
- `reviewer` 构造后不可变，可安全地连续审核任意多份文本。
- 词库项词语按等价规则处理后为空（如仅含零宽字符）会在载入时报错；
  编号重复也会报错。不同编号即使词语等价，也分别作为审核依据、分别报告。

## 等价规则（文本与词语一致）

- ASCII 字母不区分大小写；
- 全角 ASCII（U+FF01–U+FF5E）及全角空格 U+3000 等同对应半角字符；
- 忽略 U+200B、U+200C、U+200D、U+FEFF；
- 其余字符（含普通空格、换行、标点、补充平面字符）按字面匹配。

## 命中与位置语义

- 连续子串命中，不要求词语两侧有分隔符；包含、重叠、同一起点的多个词
  分别识别（Aho-Corasick 自动机，输出沿失败链合并，扫描 O(n)）。
- 每个编号只报告最早的一处（按原文起点最小）。
- 位置为原文 UTF-16 码元偏移，从 0 开始，左闭右开；范围从首个参与匹配
  的字符到最后一个参与匹配的字符，包含两者之间的忽略字符，但不包含
  两端额外的忽略字符。

## 限制与性能

- 词库：10000 项，等价处理后总长度 ≤ 100000 个 Unicode 码点。
- 单次待审文本 ≤ 4 MiB（按 UTF-8 字节计，超限抛 `RangeError`）。
- 实测：10000 项词库下连续审核 10 份 4 MiB 重复文本约 1.7 秒
  （预算 8 秒），审核结束后无堆内存滞留（峰值预算 256 MiB）。

## 目录结构

- `src/normalize.ts` —— 等价规则归一化与原文位置映射
- `src/automaton.ts` —— Aho-Corasick 自动机（逐编号最早命中）
- `src/review.ts` —— `KeywordReviewer`：词库载入、校验、审核入口
- `test/` —— 验收定位、业务规则、规模与性能测试
