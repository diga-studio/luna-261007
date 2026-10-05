# unifiedalm-local-pipeline

供 UnifiedALM 调用的本地流水线执行库（TypeScript）。运行记录保存在 SQLite（Node 内置
`node:sqlite`，无原生依赖），日志保存在调用方指定的本地目录，不包含任何接口层，
不监听端口，不依赖外部服务。

## 要求与构建

仅需 Node.js（>= 22.5，推荐 24）：

```sh
npm install
npm test        # 编译并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

## API

```ts
import { PipelineExecutor } from "unifiedalm-local-pipeline";

const executor = new PipelineExecutor({
  dbPath: "runs.sqlite",   // SQLite 文件路径，或 ":memory:"
  concurrency: 1,          // 同时执行名额，默认 1
});

// 提交运行（流水线定义已由调用方完成 YAML 解析）
const run = executor.submit(
  {
    stages: [
      { name: "Build",  steps: [{ name: "compile", command: "make", args: ["all"] }] },
      { name: "Test",   steps: [{ name: "unit", command: "npm", args: ["test"] }] },
      { name: "Deploy", steps: [{ name: "ship", command: "./deploy.sh" }] },
    ],
  },
  { logDir: "/var/log/my-run-1" }   // 调用方指定的日志目录
);

// 申请取消：Queued/Running 受理（accepted: true），终态不受理（accepted: false）
const result = executor.requestCancel(run.id);

// 查看运行与日志
const record = executor.getRun(run.id);    // RunRecord，含状态/进度/时间
const logs = executor.getLogs(run.id);     // 每步的 stdout/stderr 文件路径

await executor.drain();   // 等待所有运行到达终态
executor.close();
```

## 执行语义

- 阶段（Build/Test/Deploy）与阶段内步骤均顺序执行；步骤主程序退出码为 0 才算成功，
  非零或无法启动则本次运行为 `Failed`，后续步骤不再执行。
- 每步主程序在独立进程组中启动；主程序退出后，其尚未停止的后代进程会被停止
  （先 SIGTERM、宽限后 SIGKILL），随后才开始下一步。
- 状态机：`Queued -> Running -> Passed | Failed | Canceled`，三个终态不可改变。
- 等待中的运行按提交顺序启动，跳过已取消的运行；执行名额直到该运行的所有
  执行进程停止且日志保存完毕才释放。
- `Queued` 运行的取消一旦受理，不会启动任何步骤；`Running` 运行的取消一旦受理，
  不再启动后续步骤，最终状态只会是 `Canceled`——即使同时收到成功或失败的退出通知。
  终态运行的取消报告未受理；重复取消幂等，不会重复启动清理。
- 进入任何终态时，该运行启动的主程序及全部后代进程都已停止。

## 日志

- 每步的 stdout / stderr 分别写入 `<logDir>/NN-MM-<步骤名>.stdout.log` / `.stderr.log`，
  保留各自的接收顺序与原始字节；终止过程中仍收到的输出也会保存。
- 进入终态前日志（含 `manifest.json` 清单）已完整落盘，终态后日志不再增长。
- 步骤成败判断只依据主程序退出码，不依赖两个输出流的到达顺序。

## 测试

`npm test` 覆盖：通过/失败/无法启动、提交顺序、Queued 取消、终态后取消不受理，
以及两个关键场景——存在后代进程时取消（后代全部停止、日志冻结、后续步骤未执行）、
步骤退出与取消同时发生（受理后最终状态只有 `Canceled`）。
