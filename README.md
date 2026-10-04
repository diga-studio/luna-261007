# trimstack-metrics-archive

TrimStack 小时指标归档库（TypeScript，供上层直接调用）。

- 热数据与归档元数据：SQLite（`node:sqlite`，无原生依赖）
- 冷数据：本地无损压缩文件（gzip + NDJSON，按 UTC 天切块）
- 时间为 UTC 整数小时，由调用方提供并只能通过维护操作推进，库不读取系统时钟

## 要求

Node.js >= 22.5（内置 `node:sqlite`）。在干净机器上：

```sh
npm install
npm test
```

## API

```ts
import { TrimStackStore, readArchiveFile } from 'trimstack-metrics-archive';

// 首次创建必须提供当前小时；重开时可省略（若提供必须与已存值一致）
const store = TrimStackStore.open('/path/to/store', { initialHour: 1_000_000 });

// 1) 批量写入（原子）。同资源同小时只保留最高修订号；已过期的小时直接忽略
store.writeBatch([{ resource: 'vm-1', hour: 999_900, revision: 3, cpu: 1234 }]);

// 2) 推进业务时间并完成归档维护（原子）。可跨越多个归档/过期边界
store.maintain(1_000_100);

// 3) 查询某资源在 [fromHour, toHour) 内的统计（缺报不计零，冷热不重复计）
const stats = store.query('vm-1', 999_000, 1_000_000);
// => { hours, totalCpu, maxCpu }

store.close();
```

- 利用率 `cpu` 为 0–10000 的整数（百分之一个百分点）。
- 保留范围 `[T-2160, T)`；其中 `[T-720, T)` 为热数据，更早为冷数据。
- 冷数据补报/修正立即对查询生效，并在下一次维护时折叠进压缩归档。
- `readArchiveFile(path)` 可独立读回任一冷归档的完整指标内容。

## 存储布局

```
<dir>/metrics.db          SQLite：当前小时 T、热表、冷修正增量表、归档注册表
<dir>/archives/*.jsonl.gz 冷数据压缩归档（每天一个块）
```

## 崩溃安全设计

- 写入批次：单条 SQLite 事务，要么全生效要么全不生效。
- 维护：新归档先写临时文件、fsync、原子 rename；随后单个 SQLite 事务完成
  归档注册、热/增量数据清除与 T 推进；事务提交后再删除废弃档案文件。
- 进程在任意点被终止后重开：已确认操作完整保留；未确认操作完整生效或完全
  未生效。恢复时会删除废弃档案与孤儿临时文件，且恢复本身可反复中断重试，
  最终完成一次重开加维护后不留任何无用文件。
