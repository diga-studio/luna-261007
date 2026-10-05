# ContentHub 关键词审核库

由内容保存流程直接调用的 TypeScript 库：在保存前审核单个字段的纯文本，
返回是否拦截以及命中的词库编号与原文范围（可直接用于编辑器高亮）。
词库保存在本地 JSON 文件；待审文本与审核结果不持久化。

## 构建与测试

只依赖 Node.js 与 npm（开发依赖仅 `typescript`）：

```sh
npm install
npm test
```

`npm test` 会先用 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行全部测试。

## 词库格式

本地 JSON 文件，内容为数组，每项包含稳定编号与词语：

```json
[
  { "id": 1, "word": "ab" },
  { "id": 2, "word": "ＡＢ" },
  { "id": 3, "word": "b" }
]
```

词语按等价规则处理后必须非空；不同编号即使词语等价，也分别作为审核依据报告。

## 等价规则

文本与词语使用相同规则：

- ASCII 字母不区分大小写；
- 全角 ASCII 字符（`U+FF01..U+FF5E` 与全角空格 `U+3000`）等同对应半角字符；
- 忽略 `U+200B`、`U+200C`、`U+200D`、`U+FEFF`；
- 其余字符按字面匹配（普通空格、换行、标点不可跳过）。

采用连续子串命中，不要求词语两侧有分隔符；包含、重叠及同一起点的多个词分别识别。

## 用法

```ts
import { KeywordReviewer } from "./src/index.js";

const reviewer = KeywordReviewer.loadFromFile("lexicon.json");
const result = reviewer.review("待审纯文本");
// result.blocked: 有任何命中即 true
// result.hits: [{ id, start, end }]，按编号升序；每个编号只报告最早一处
```

- 位置按原文 UTF-16 码元计数，从 0 开始，左闭右开；
- 范围从首个实际参与匹配的字符开始，到最后一个参与匹配的字符结束，
  包含两者之间的忽略字符，不包含两端额外的忽略字符；
- 输入是已提取的纯文本，不解析富文本；单次待审文本不超过 4 MiB（UTF-8），超出抛错；
- 词库载入后不可变，可并发安全地连续审核多个字段。

## 实现说明

- `src/normalize.ts`：等价规则与归一化；纯字面 BMP 文本走零分配恒等快路径，
  否则以生成器流式产出归一化码点并同步写入可复用的位置映射缓冲区。
- `src/automaton.ts`：Aho-Corasick 多模式匹配；每个模式一次扫描只报告最早命中，
  已通过字典序后缀链路径压缩避免长重复文本上的退化。
- `src/review.ts`：词库载入校验（等价词合并到同一模式、编号分别报告）与审核入口。

规模：词库 10000 项、归一化后总长 ≤ 100000 码点；连续审核 10 份 4 MiB 文本
总耗时 ≤ 8 秒、峰值内存 ≤ 256 MiB（由 `tests/scale.test.ts` 与
`tests/scale-transform.test.ts` 验证）。
