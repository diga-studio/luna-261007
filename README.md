# sensitive-word-review

敏感词审核库：词表存 SQLite，评价文本由调用方传入，供评价收集和人工审核模块直接调用。

## 要求

- Node.js >= 23.4（使用内置 `node:sqlite` 与 `node:test`，无原生编译依赖）

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { SensitiveWordReview } from "./src/index.js";

const review = new SensitiveWordReview("words.db");

// 全量替换词表（事务提交，重新打开库后仍可使用）
review.replaceEntries([
  { id: 1, text: "ﬃ" },
  { id: 2, text: "é" },
]);

// 检查一条评价，返回全部命中（含重叠）
const hits = review.check("😀xﬃy");
// => [{ entryId: 1, start: 3, end: 4 }]

review.close();
```

## 匹配语义

词条与评价使用同一套标准化：

1. 忽略 U+200B、U+2060、U+FEFF；
2. 以整段文字的 Unicode NFKC 结果为准；
3. 英文字母 A-Z 视同 a-z。

不额外忽略空白、标点或其他字符，所有词条都是字面文本，按连续子串匹配，返回全部命中（包括相互重叠的命中）。不同编号的词条即使标准化后相同也分别报告；标准化后为空的词条不产生命中。

## 命中区间

- 按原文 UTF-16 代码单元计数，起点包含、终点不包含，可直接用于在原始评价上高亮。
- 忽略隐形字符后，剩余原文的 Unicode 扩展字素簇是最小高亮单位；参与生成命中文字的字素簇完整覆盖，区间取这些字素簇在原文中最左起点至最右终点。
- 兼容字符展开为多个字符时，命中只占展开结果的一部分也高亮完整原始字符。
- 跨字符命中的区间包含内部被忽略的隐形字符，但不吸收区间首尾之外的隐形字符。
- 同一词条落在同一原文区间的多次命中只报告一次。
