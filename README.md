# net-dependency-attribution

网络依赖归属库。根据 IP 归属时间线与连接遥测，维护有向资产依赖图，数据保存在 SQLite。
由上层直接调用；资产 ID 与 IP 写法已由上层统一，本库不做资产识别。

## 环境要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无任何原生模块或外部服务）
- `npm install && npm test` 即可构建并运行全部测试（唯一开发依赖是 TypeScript）

## API

```ts
import { DependencyStore } from 'net-dependency-attribution';

const store = new DependencyStore('deps.db'); // 或 ':memory:'

// 1. 登记 / 修订一个 IP 的完整归属时间线（每次调用整体替换）
//    区间 [startMs, endMs)，互不重叠，允许空档，UTC 毫秒
store.reviseOwnership('10.0.0.1', [
  { startMs: 1700000000000, endMs: 1700003600000, assetId: 'asset-a' },
]);

// 2. 批量接收连接观测（可乱序、迟到、重复；重复 ID 只计一次）
store.ingest([
  { id: 'obs-1', srcIp: '10.0.0.1', dstIp: '10.0.0.2',
    observedAtMs: 1700000001000, severity: 'critical' },
]);

// 3. 读取指定资产对的依赖，或完整依赖图
//    nowMs 由调用方提供，不早于全部观测时间；距最后观察 72 小时标记 stale
store.getDependency('asset-a', 'asset-b', Date.now());
store.getGraph(Date.now());

store.close();
```

## 语义

- 观测两端资产分别按**观察时间**查找归属；任一端落在空档或两端同属一个资产时
  不形成依赖，但观测保留，后续修订可重新归属。
- 依赖按有向资产对合并：`supportCount` 为支持观测数，`lastObservedAtMs` 取最大值，
  `severity` 取最高等级（critical > standard > informational）。
- 修订会追溯该 IP 的全部历史观测并重算受影响边：旧边可能降级、回退时间或消失，
  新边可能出现；仍被其他观测支持的旧边不会丢失。
- `stale` 只是读取时的标记（`nowMs - lastObservedAtMs >= 72h`），不删除依赖。

## 实现要点

- `observations` 表存原始观测及当前解析出的两端资产；`edges` 表物化聚合结果。
- 导入走增量合并（计数 +1、时间/等级取 max），对纯追加是精确的。
- 修订只重算受影响的有向对（从观测表聚合），因此降级与回退都精确，
全貌与“按全部原始观测独立重算”一致（有随机化测试保证）。

## 测试

`npm test` 覆盖：

- IP 转移边界上的乱序与重复观测
- 空档补齐后重新生成依赖，并与正常顺序导入结果一致
- 唯一 critical 观测 / 最后一条观测改归他处：旧边降级、回退或消失，新边不多计
- 同资产连接拆开后生成依赖；72 小时恰好到期
- 随机化修订与独立全量重算的一致性
- 规模验证：100 万观测、2 万资产、连续 100 次单 IP 修订并读取受影响依赖，
  总耗时远低于 5 秒（初始导入不计时）
