# task26100761

## probekit-recommendation-cache

TypeScript 推荐缓存库：纯内存、按用户隔离、按全局数据版本划分。
本模块不实现推荐算法，推荐计算由上层通过 `compute` 回调注入。

### 使用

```ts
import { RecommendationCache } from "probekit-recommendation-cache";

const cache = new RecommendationCache({
  // 上层提供的本地异步推荐计算器：接收用户标识与数据版本
  compute: async (userId, version) => ["u1@v1#item"],
  // 可选参数（默认值如下）
  initialVersion: 0,
  budgetMs: 5000,    // 每次未命中查询的等待预算
  freshMs: 600000,   // 成功结果的新鲜时长
});

const result = await cache.getRecommendations("user-1");
// result.kind: "fresh" | "stale" | "unavailable"

cache.switchVersion(2); // 全局数据版本只递增
```

### 结果类型

- `fresh`：正常结果（新鲜缓存命中或预算内计算成功），含 `items` 与 `version`。
- `stale`：计算失败或预算耗尽时的陈旧降级，返回当前版本最近一次成功结果。
- `unavailable`：暂不可用，当前版本没有任何成功缓存。

### 行为规则

- 同一用户、同一版本同时最多一次未完成计算，并发查询共享它；不同用户互不阻塞。
- 每次查询自带 `budgetMs` 截止点，加入已有计算不延长也不缩短自己的预算。
- 查询超时不取消计算；迟到成功可更新同版本缓存，但不改变已结束的查询。
- 版本切换后旧缓存立即失效；未结束的查询用剩余预算继续尝试新版本，截止点不变。
- 旧版本计算无论成败都不会污染新版本缓存、结束新版本等待者或阻塞新计算。

### 构建与测试

```sh
npm install
npm test
```
