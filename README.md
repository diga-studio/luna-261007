# content-library-stats

内容库分类统计模块（TypeScript 库，无接口层），数据保存在 SQLite（Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（`node:sqlite`）

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { ContentLibrary } from "content-library-stats";

const lib = new ContentLibrary();                 // 内存库
// const lib = new ContentLibrary({ filename: "data.sqlite" }); // 持久化到文件

lib.addCategory("A", null);      // 顶层分类（第 1 层，最多 4 层）
lib.addCategory("A1", "A");

lib.upsertArticle({              // 新增或整体替换一篇文章
  id: "post-1",
  published: true,               // 仅已发布文章参与统计
  categoryIds: ["A1"],           // 直接归属，0–8 个
});

lib.moveCategory("A1", null);    // 子树整体迁移到顶层或另一父分类下

lib.getCoverageCount("A");       // 覆盖计数：自身及全部后代范围内已发布文章去重数
lib.close();
```

## 语义约定

- 一个分类的覆盖范围 = 自身 + 全部后代；文章命中范围内任一分类即计 1 次，多处命中不重复计数。
- `upsertArticle` 整体替换发布状态与直接归属；重复提交相同内容计数不变。
- `moveCategory` 保留子树内部关系与文章直接归属；子树内部分类的覆盖计数不因迁移改变。
- 所有修改在单个事务内完成，方法返回后读取到的即为整次修改后的状态。
- 层级超过 4 层、归属超过 8 个、迁移形成环等情况会抛出错误。
