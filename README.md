# trimstack-metrics

TrimStack 小时指标归档库（TypeScript，供上层直接调用）。

- 热数据与归档元数据：SQLite（`node:sqlite`，零原生依赖）
- 冷数据：本地无损压缩文件（gzip JSON，`node:zlib`）
- 运行要求：Node.js >= 23.4（`node:sqlite` 免 flag）；仅使用 Node 内置模块

## 构建与测试

```sh
npm install
npm test        # 等价于 npm run build && node --test "dist/test/*.test.js"
```

## API

```ts
import { TrimStack } from 'trimstack-metrics';

// 首次创建必须提供 initialT（UTC 整数小时）；重开时忽略 initialT
const ts = TrimStack.open({ dir: '/data/metrics', initialT: 1_000_000 });

ts.writeBatch([{ resource: 'vm-1', hour: 999_900, revision: 3, utilization: 1234 }]);

ts.maintain(1_000_024);          // 推进业务时间 T，完成归档维护（原子）
const stats = ts.query('vm-1', 999_000, 1_000_000); // { hours, totalUtilization, maxUtilization }
ts.close();
```

- `writeBatch(records)`：原子批量写入。同一 `(resource, hour)` 只保留最高 `revision`；
  已过期（早于 `T-90d`）或不早于 `T` 的小时直接忽略。`utilization ∈ [0, 10000]`。
- `maintain(newT)`：原子地把 `T` 推进到 `newT`（`newT < T` 报错；`newT === T` 为幂等空操作，便于重试）。
  冷区间 `[T-90d, T-30d)` 的数据折叠进压缩归档，过期数据与无用档案清除。
- `query(resource, start, end)`：区间左含右不含，裁剪到保留范围 `[T-90d, T)`；
  冷热数据按小时取最高修订号合并，缺报不计零。

## 崩溃安全设计

- 写批次 = 单个 SQLite 事务；维护 = 归档文件先行（tmp + fsync + rename + 目录 fsync），
  然后一个 SQLite 事务同时提交归档元数据、热数据删除与 `T` 的推进。
- 归档文件按世代唯一命名，永不原地覆盖；被替换/过期的旧文件先记入
  `pending_delete` 表（同事务提交），再在事务外删除。
- 重开时的恢复是幂等的：删除未被元数据引用的孤儿文件（含临时文件），
  并补做已提交但未完成的 `pending_delete`。恢复可任意中断重入。
- 因此未确认的操作只会完整生效或完全未生效；重试不会降低修订号、
  重复计数或复活过期指标。

## 目录结构

```
<dir>/metrics.db      SQLite：meta(T)、hot、archives(窗口->文件)、pending_delete
<dir>/archives/       cold-<窗口起始小时>-<uuid>.json.gz
```

测试（`test/`）包含：30/90 天边界与冷热区多次修正、随机工作负载与参考模型对拍、
各维护阶段崩溃后重开、恢复反复中断与重试、归档独立读回校验，
以及 500 资源 × 90 天（108 万条）规模验收。
