# netdep-attribution

网络依赖归属库：根据 IP 归属时间线与连接遥测，维护有向资产依赖图。数据保存在 SQLite（`node:sqlite`，零原生依赖）。

## 要求

- Node.js >= 22.13（内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试（含 100 万观测规模的耗时验证）

## API

```ts
import { AttributionStore } from 'netdep-attribution';

const store = new AttributionStore('deps.db'); // 或 ':memory:'

// 1. 登记/修订某个 IP 的完整归属时间线（[startMs, endMs)，互不重叠，允许空档）
store.reviseTimeline('10.0.0.1', [
  { startMs: t0, endMs: t1, assetId: 'asset-a' },
  { startMs: t2, endMs: null, assetId: 'asset-b' }, // endMs=null 表示开放区间
]);

// 2. 批量接收连接观测（可乱序、迟到、重复；重复 id 只计一次）
store.ingest([
  { id: 'obs-1', srcIp: '10.0.0.1', dstIp: '10.0.0.2', observedAtMs: t, severity: 'critical' },
]);

// 3. 读取依赖（nowMs 由调用方提供，不早于全部观测时间）
const dep = store.getDependency('asset-a', 'asset-b', nowMs);
// => { srcAsset, dstAsset, supportCount, lastObservedAtMs, severity, stale } | null
const graph = store.getGraph(nowMs); // 完整依赖图

store.close();
```

## 语义

- 观测两端资产分别按**观察时间**查找归属；任一端落在空档或两端同属一个资产时不形成依赖，但观测保留，后续修订可重新归属。
- 依赖按有向资产对合并：`supportCount` 为支持观测数，`lastObservedAtMs` 取最大值，`severity` 取最高等级（critical > standard > informational）。
- 修订时间线会追溯全部相关历史观测：旧边计数/时间/等级相应回退或消失，新边出现；只重算受影响的边，不丢其他观测仍支持的依赖。
- 距最后观察时间达到 72 小时（含恰好 72h）标记 `stale: true`，不删除依赖。

## 脚本

- `npm run build` — 编译到 `dist/`
- `npm test` — 编译并运行全部测试（正确性 + 规模耗时验证）

## 结构

- `src/types.ts` — 公共类型与常量
- `src/timeline.ts` — 时间线校验与按时间点二分查找归属（纯函数）
- `src/db.ts` — SQLite schema
- `src/store.ts` — 核心：修订追溯、观测去重与归属、边聚合维护、读取
- `test/correctness.test.ts` — 业务规则测试
- `test/perf.test.ts` — 100 万观测 / 2 万资产下 100 次修订+读取 < 5s 验证
