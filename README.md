# probekit-recommendation-cache

ProbeKit 推荐缓存模块（TypeScript 库）。缓存与运行状态只存内存，不实现推荐算法——
推荐计算由上层注入的本地异步计算器完成。

## 能力

- **按用户查询推荐** `query(userId)`：新鲜缓存直接返回；未命中时共享/发起计算，
  每次查询有独立的 5000ms 等待预算；计算失败或预算耗尽时降级为当前版本的
  陈旧缓存，没有则返回暂不可用。
- **切换全局数据版本** `setVersion(version)`：版本只递增。切换后旧缓存失效，
  等待中的查询在原截止点不变的前提下改等新版本；旧计算的迟到结果（无论成败）
  不会污染新版本缓存、不会结束新版本的等待者。

## 使用

```ts
import { RecommendationCache } from 'probekit-recommendation-cache';

const cache = new RecommendationCache<string>({
  // 上层提供的本地异步推荐计算器：接收用户标识和数据版本，返回推荐列表
  compute: async (userId, version) => fetchRecommendations(userId, version),
  initialVersion: 1,
  // freshTtlMs: 600_000,   // 新鲜期，默认 600000ms
  // waitBudgetMs: 5_000,   // 单次查询等待预算，默认 5000ms
  // clock: new SystemClock() // 可注入时钟（测试用）
});

const result = await cache.query('user-1');
switch (result.status) {
  case 'fresh':       // 命中新鲜缓存
  case 'computed':    // 本次计算在预算内正常完成
    break;
  case 'stale':       // 降级：返回当前版本的陈旧缓存
    break;
  case 'unavailable': // 暂不可用：无缓存可降级
    break;
}

cache.setVersion(2); // 数据导入后切换版本（必须递增，否则抛错）
```

## 语义要点

- 缓存按用户隔离并属于一个数据版本；成功计算完成起 600000ms 内为新鲜，
  之后为陈旧，陈旧缓存保留到同版本新结果替换或版本切换使其失效。
- 同一用户、同一版本同时最多一次未完成计算；不同用户完全独立。
- 查询超时不结束计算：迟到成功仍更新同版本缓存，但不改变已结束的查询结果。
- 计算失败不清缓存，后续查询可重新发起计算。

## 构建与测试

只依赖 Node.js 与 npm（devDependencies：typescript、@types/node）：

```sh
npm install
npm test        # 编译并运行全部测试（node:test + 假时钟，秒级完成）
npm run build   # 仅编译到 dist/
```
