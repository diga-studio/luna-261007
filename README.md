# unifiedalm-pipeline-runner

供 UnifiedALM 调用的本地流水线执行库（无接口层）。运行记录保存在 SQLite，日志保存在调用方指定的本地目录。

## 安装与测试

```sh
npm install
npm test
```

仅需 Node.js（>= 18）。SQLite 由 sql.js（WebAssembly）提供，无需原生编译、无需外部服务。

## API

```ts
import { PipelineRunner } from './src/index';

const runner = new PipelineRunner({
  dbPath: '/var/alm/runs.db',   // SQLite 运行记录
  logDir: '/var/alm/logs',      // 日志根目录（调用方指定）
  maxConcurrent: 1,             // 执行名额，默认 1
});
await runner.init();

// 提交运行（YAML 已由调用方解析为对象）
const runId = await runner.submit({
  stages: [
    { name: 'Build',  steps: [{ name: 'compile', command: 'make', args: ['all'] }] },
    { name: 'Test',   steps: [{ name: 'unit', command: 'npm', args: ['test'] }] },
    { name: 'Deploy', steps: [{ name: 'ship', command: './deploy.sh' }] },
  ],
});

runner.cancel(runId);        // { accepted: boolean, status }
runner.getRun(runId);        // RunRecord（状态/原因/时间戳）
runner.getLogs(runId);       // 每步的 stdout/stderr 文件路径
await runner.close();        // 等待在途运行彻底结束后关闭
```

## 语义保证

- 状态机：`Queued → Running → Passed / Failed / Canceled`，三个终态不可改变。
- 阶段与步骤严格顺序执行；退出码非零或无法启动即 `Failed`，后续步骤不再执行。
- 每个步骤的主程序退出后，其尚未停止的后代进程会被终止（POSIX 进程组 `SIGTERM`→`SIGKILL`，Windows `taskkill /T /F`），然后才开始下一步。
- 等待中的运行按提交顺序启动，跳过已取消的；名额直到该运行全部进程停止且日志保存完毕才释放。
- 取消：`Queued` 受理后不会启动任何步骤；`Running` 受理后不再启动后续步骤，且终态只会是 `Canceled`（取消优先于同时到达的退出通知）；终态运行的取消不受理；重复取消幂等。
- 日志：每步 `stdout`/`stderr` 分文件保存，按到达顺序写入原始字节；终止过程中迟到的输出也会保存；进入终态前日志已封存，终态后不再增长。步骤成败只依据主程序退出码，不依赖两个流的到达顺序。

## 目录结构

- `src/types.ts` — 公开类型
- `src/pipeline-runner.ts` — 对外入口（提交/取消/查询、队列与名额调度）
- `src/run-executor.ts` — 单次运行的状态机与取消逻辑
- `src/process-killer.ts` — 进程组启动与整树终止
- `src/log-store.ts` — 日志文件写入
- `src/db.ts` — SQLite 运行记录
- `test/` — 自动化测试（含“后代进程取消”“退出与取消竞争”两个场景）
