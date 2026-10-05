# sensitive-word-review

敏感词审核库：词表存 SQLite，由评价收集和人工审核模块直接调用。
评价文本由调用方传入，命中区间按原文 UTF-16 代码单元计数，可直接用于在原始评价上高亮。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生编译依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 能力

- `replaceWords(entries)`：全量替换词表（事务原子提交），重新打开库后仍可用
- `check(reviewText)`：检查一条评价，返回全部命中（含重叠、含同形不同编号词条）

## 匹配语义（词条与评价一致）

1. 先忽略 U+200B、U+2060、U+FEFF；
2. 以整段文字的 Unicode NFKC 结果为准；
3. 将英文字母 A-Z 视同 a-z。

不额外忽略空白、标点或其他字符；所有词条都是字面文本，按连续子串匹配。

## 命中区间

- 按 UTF-16 代码单元计数，起点包含、终点不包含；
- 剔除隐形字符后，剩余原文的 Unicode 扩展字素簇是最小高亮单位，
  参与命中的字素簇完整覆盖（如兼容连字 `ﬃ` 展开为 `ffi`，词条 `f` 也高亮整个 `ﬃ`）；
- 跨字符命中的区间包含内部被忽略的隐形字符，但不吸收区间首尾之外的隐形字符；
- 同一词条落在同一原文区间的多次命中只报告一次。

## 用法

```ts
import { SensitiveWordStore } from "sensitive-word-review";

const store = new SensitiveWordStore("words.db");
store.replaceWords([
  { id: 1, text: "f" },
  { id: 2, text: "fi" },
]);

const hits = store.check("😀xﬃy");
// => [ { id: 1, start: 3, end: 4 }, { id: 2, start: 3, end: 4 } ]

store.close();
```

## 脚本

- `npm run build`：编译 `src` 与 `test`
- `npm test`：构建并运行全部测试
