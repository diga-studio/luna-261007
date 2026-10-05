# PurgeWave — 可撤销批量清理库

TypeScript 库，供上层直接调用（无接口层）。清理后的文件内容由模块保留
30×24 小时，期间可撤销；到期后由回收操作永久删除。作业记录存 SQLite，
进程意外退出后重开模块会先恢复中断操作，再接受新操作。

## 使用

```ts
import { PurgeWave } from "purgewave";

const pw = new PurgeWave({ storageDir: "/var/lib/myapp/purgewave" });

const job = pw.purge("job-2026-10-06-a", ["/data/a.log", "/data/b.log"]);
const undone = pw.undo("job-2026-10-06-a");   // 恢复到原路径，逐字节一致
const done = pw.reclaim("job-2026-10-06-a");  // 到期后永久删除保留内容
const view = pw.getJob("job-2026-10-06-a");   // 查看逐文件状态
pw.close();
```

- 每个作业最多 5000 个不同路径；同一编号重复提交沿用首次清单与进度。
- 逐文件状态：`pending` / `purged` / `restored` / `conflict` / `reclaimed` / `missing`。
- 撤销时原路径被占用（文件或目录）记为 `conflict`，内容继续保留，
  占用解除后再次 `undo` 即可续恢复；绝不覆盖占用者。
- 保留期从作业首次接收时刻起算，重试与重开都不会延长；
  到达截止时间后不可再新发起撤销。
- 构造参数 `now?: () => number` 可注入时钟（测试用）；
  `faultHook` 为测试专用的崩溃注入点。

## 崩溃安全协议

- 每个文件变更（rename / 删除）后立即提交对应的记录更新（SQLite 自动提交，
  WAL + synchronous=FULL）。
- 重开时先把记录与文件系统对账（blob 在而记录未更新 → 按已完成处理），
  再续跑中断的清理/撤销/回收，最后清扫无法归属到作业条目的保留内容。
- 撤销/回收的到期判断固定在操作首次接收时（`ops` 表持久化），
  中断后继续执行沿用原判断。

## 构建与测试

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`，无运行时依赖）。

```sh
npm install
npm test
```
