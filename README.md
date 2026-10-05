# PurgeWave — 可撤销清理模块

以库形式供上层调用的 TypeScript 模块：把调用方选好的文件移入模块保留区，
30 天内可逐字节撤销恢复，到期后永久回收。作业记录存 SQLite，不启任何服务。

## 要求

- Node.js >= 22.13（使用内置 `node:sqlite`，无原生依赖）
- `npm install` 后 `npm test` 即可构建并运行全部测试

## API

```ts
import { PurgeWave } from "purgewave";

const pw = new PurgeWave({ dir: "/var/lib/purgewave" });

pw.clean("job-001", ["/data/a.log", "/data/b.log"]); // 清理
pw.undo("job-001");                                  // 撤销（恢复到原路径）
pw.reclaim("job-001");                               // 到期回收（删除保留内容）
pw.getJob("job-001");                                // 查看作业
pw.close();
```

- `new PurgeWave({ dir, now?, crashHook? })`
  - `dir`：模块存储目录（SQLite 与保留内容都在其中），由调用方指定。
  - `now`：可选时钟注入（毫秒时间戳），默认 `Date.now`。
  - `crashHook`：可选测试钩子，在每个文件步骤之间回调，用于模拟进程退出。
- 每个作业的保留期为首次接收时起连续 30×24 小时；重试、重开模块均不延长。
- 每个作业最多 5000 个不同路径；重复提交同一编号沿用首次清单与进度。
- 逐文件状态：`pending`（尚未处理）、`cleaned`（已清理）、`restored`（已恢复）、
  `conflict`（恢复冲突，内容仍保留）、`purged`（已永久回收）。
- 撤销时原路径被占用则记为 `conflict`，不覆盖占用者；占用解除后再次 `undo` 可继续。
- 到达截止时间后 `undo` 抛 `EXPIRED`；未到期 `reclaim` 抛 `NOT_EXPIRED`。

## 崩溃恢复

进程可能在任何一次文件变化或记录更新之后退出。模块对每个文件按
“先记录意图 → 再移动/删除 → 再记录结果”的顺序推进，每步都即时落库。
重开模块（构造 `PurgeWave`）时会先恢复所有中断操作、清理无主保留内容，
再接受新操作或返回作业结果：

- 清理中断：已移动未记录的按已清理补记；已记录未移动的重新移动。
- 撤销中断：已还原未记录的补记；未完成的继续还原；冲突保留待重试。
- 回收中断：沿用该操作首次接收时的截止时间判断，继续删除仍保留的内容。
- 结果未返回就退出：重试同一编号幂等，不重复处理已成功项。
