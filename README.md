# cms-graphql-reader

只读的 CMS 公开内容 GraphQL 查询组件：TypeScript + SQLite（`node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（内置 `node:sqlite`）

## 使用

```bash
npm install
npm test
```

```ts
import { createCmsReader } from './src';

const reader = createCmsReader();
reader.load(
  [{ id: 1, rank: 1, published: true }],   // 可迭代
  [{ from: 1, to: 1 }],                    // 有向边，可共享目标/自引用/成环
);
const result = reader.execute(
  `{ articles(offset: 0, limit: 20) { id rank related { id } } }`,
  {},
);
```

## 语义

- `articles` 与 `Article.related` 均返回 Article 列表，接受 `offset`（默认 0）、`limit`（默认 20）。
- 先过滤已发布文章，再按 `rank` 升序、数字 `id` 升序排序，最后跳过 `offset` 项取 `limit` 项。
- 未发布文章不出现在任何结果中（含关联列表）；`related` 在每个父文章的出边目标中独立分页。
- `id` 为 GraphQL `ID` 类型（序列化为字符串），`rank` 为 `Int`。
- 支持变量（含默认值）、别名、命名片段、行内片段、`@skip`/`@include` 指令。
