# gps-tracker

现场员工 GPS 轨迹的每日行驶距离核算库（TypeScript + SQLite）。设备离线补传历史定位点后，日行驶距离立即修正，无需调用方整理历史或整体重导。

## 使用

```ts
import { openTracker } from "gps-tracker";

const tracker = openTracker("/path/to/tracker.db"); // 打开或创建 SQLite 文件

tracker.ingestBatch([
  {
    pingId: "p-0001",      // 全局唯一，内容不可变；仅 ASCII
    employeeId: "emp-1",
    deviceId: "dev-9",
    timestamp: 1717171200000, // Unix 毫秒
    latitude: 31.23,
    longitude: 121.47,
    accuracy: 12.5,        // 英尺
  },
]);

tracker.getDaily("emp-1", "2024-05-31"); // => 米；无距离返回 0
tracker.close();                          // 正常关闭后结果持久保留
```

## 构建与测试

```sh
npm install
npm test
```

要求 Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部依赖；SQLite 即本库唯一的存储）。

## 核算规则

- 排除 `accuracy > 100` 英尺的点；同一员工、同一设备、同一 timestamp 的多个剩余点只采用 pingId 按 ASCII 字节序最小者。
- 每个设备各自按 timestamp 升序构成轨迹，只在相邻点间连边；时间差超过 30 分钟的间隔贡献 0；不同设备之间不连边。
- 相邻点距离用 haversine（地球半径 6371008.8 米）；跨 UTC 午夜的边按落在各日期的毫秒数比例分摊。
- 重复 pingId（批内/跨批）只生效一次；晚到点立即插入轨迹中间修正两侧贡献；更小 pingId 的同时间戳点会替换旧点并撤销其旧贡献。

## 增量设计

`ingestBatch` 返回时，所有日期的结果即等价于对全部已收 ping 的重算，且与批次切分、批内顺序、批次到达顺序、重复次数无关。其实现方式：

- SQLite 三张表：`seen(ping_id)` 去重；`points(employee_id, device_id, ts, ...)` 保存当前每个 (员工, 设备, 时间戳) 的胜出点；`daily(employee_id, day, dist)` 保存累计距离。
- 每个新有效点只做 O(log n) 工作：在 `points` 主键索引上找到同设备的前驱/后继，撤销旧边（前驱→后继，或被替换点的两条边），加入新边（前驱→新点→后继）的按日分摊增量。不扫描历史、不重扫受影响日期。
- `getDaily` 是对 `daily` 表的主键点查，不遍历轨迹。
- 额外工作内存为常数级（预编译语句 + SQLite 页缓存），与历史规模无关。
