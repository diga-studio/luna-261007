# gps-track-ledger

现场员工 GPS 轨迹日行驶距离核算库（TypeScript + SQLite）。设备离线补传历史定位点时，
日距离在 `ingestBatch` 返回前即被增量修正，无需整体重导。

## 使用

```ts
import { GpsTracker } from "gps-track-ledger";

const tracker = new GpsTracker("/path/to/ledger.db");
tracker.ingestBatch([
  {
    pingId: "abc123",
    employeeId: "emp-1",
    deviceId: "dev-9",
    timestamp: 1710000000000, // Unix 毫秒
    latitude: 31.23,
    longitude: 121.47,
    accuracy: 25, // 英尺
  },
]);
const meters = tracker.getDaily("emp-1", "2024-03-09"); // UTC 日累计距离（米）
tracker.close();
```

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 22.5，使用内置 `node:sqlite`）与 devDependencies 中的
`typescript` / `@types/node`，无原生模块、无外部服务。

## 设计

- `points` 表以 `(employee_id, device_id, ts)` 为主键，只保存该时间戳上
  pingId（ASCII 字节序）最小的有效点（accuracy ≤ 100 英尺）。
- `daily` 表保存 `(employee_id, day_start)` 的累计米数。
- 每条 ping 到达时只做 O(log n) 的前驱/后继查询：
  - 新点：撤销旧 `prev→next` 边的贡献，加入 `prev→new`、`new→next` 两条边。
  - 同时间戳更小 pingId：撤销旧点两侧边的贡献，按新坐标重加。
  - 重复或更大的 pingId：直接跳过。
- 边贡献 = haversine（R=6371008.8 m），仅当间隔 ≤ 30 分钟；跨 UTC 午夜的边
  按落在各日期的毫秒数比例分摊。所有修正与导入同事务提交，`getDaily`
  只是一次主键查询。
- 正常关闭后重开数据库，结果保留（WAL 模式）。
