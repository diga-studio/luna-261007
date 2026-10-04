# cms-graphql-reader

只读 CMS 公开内容的 GraphQL 读取组件（TypeScript + SQLite）。

- `load(articles, edges)`：从可迭代输入重建 SQLite（内存库）中的数据。
- `execute(document, variables)`：执行 GraphQL 查询。
- 根字段 `articles` 与 `Article.related` 均支持 `offset`（默认 0）、`limit`（默认 20），
  语义为：先过滤已发布文章，按 `rank` 升序、`id` 升序排序，再跳过 `offset` 取 `limit` 项。
  每个父文章的 `related` 独立分页，互不影响。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`）。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { createCms } from 'cms-graphql-reader';

const cms = createCms();
cms.load(
  [{ id: 1, rank: 0, published: true }],
  [],
);
const result = await cms.execute('{ articles { id rank related { id } } }');
```
