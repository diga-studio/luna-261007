# task26100764

内容库分类覆盖统计模块（TypeScript 库，SQLite 持久化，无接口层）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生依赖）

## 使用

```bash
npm install
npm test
```

```ts
import { CategoryStats } from "./src";

const stats = new CategoryStats({ dbPath: "data.db" }); // 或 ":memory:"

const root = stats.createCategory("科技", null);      // 顶层
const child = stats.createCategory("AI", root);       // 最多四层

stats.upsertArticle({ id: "a1", status: "published", categoryIds: [child] });
stats.moveCategory(child, null);                      // 子树迁移 / 移到顶层
const n = stats.getCoverageCount(root);               // 覆盖计数（含后代，去重）
stats.close();
```

## 设计要点

- 计数在读取时基于当前分类树用递归 CTE 实时计算：文章命中子树内多个分类只计一次，
  迁移、归属替换、状态切换在事务提交后整体可见，重复提交幂等。
- 约束：分类最多 4 层、文章直接归属最多 8 个、仅 `published` 参与统计，非法输入抛错。
