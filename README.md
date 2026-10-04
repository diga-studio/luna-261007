# task26100703

RTOS 任务配置准入分析库（TypeScript）。上层在向农业设备（灌溉控制器 /
自主农机）下发配置前调用，给出可解释的准入结论。候选配置与分析结果仅
保存在内存，无接口层、无持久化。

## 模型

- 单核、固定优先级、完全抢占的周期任务；优先级数字越小越优先。
- 所有任务在时刻 0 同时首次释放，此后严格按各自周期释放。
- 每个实例使用声明的最坏执行耗时；不考虑阻塞、中断、释放抖动与调度开销。
- 旧实例未完成时新实例仍正常释放，不合并、不丢弃；超时实例继续执行至完成。
- 实例截止时刻 = 释放时刻 + 相对截止期限；恰好压线完成算成功；
  截止期限允许大于周期（可能出现多实例积压）。
- 所有时间均为正整数微秒。

## 结论规则

1. CPU 总负载（各任务 WCET/周期 之和）超过 85% → 直接拒绝，仅说明负载原因；
   恰好 85% 允许继续检查。负载比较为 BigInt 精确比例判断。
2. 负载合格 → 对每个任务做忙期（level-i busy period）响应时间分析：
   - 存在超时实例 → 拒绝，并给出一个真实超时实例（任务、释放时刻、
     完成时刻、绝对截止时刻）供工程师复核；
   - 全部实例按时完成 → 通过，并报告各任务的最大响应时间。

## 使用

```ts
import { analyzeConfig } from "rtos-admission-analysis";

const verdict = analyzeConfig({
  tasks: [
    { id: "sampler", priority: 0, worstCaseExecutionTime: 50_000, period: 100_000, relativeDeadline: 100_000 },
    { id: "controller", priority: 1, worstCaseExecutionTime: 26_000, period: 75_000, relativeDeadline: 77_000 },
  ],
});
// verdict.kind: "accepted" | "rejected-utilization" | "rejected-deadline"
```

另导出 `checkUtilization`（精确负载计算）、`analyzeResponseTimes`（忙期
响应时间分析）与 `simulateHyperperiod`（覆盖完整重复周期的独立事件驱动
仿真，用于交叉验证）。

## 构建与测试

只需 Node.js：

```sh
npm install
npm test
```

`npm test` 先用 tsc 编译到 `dist/`，再用 Node 内置测试运行器执行
`test/` 下的用例，包括题目给定场景（76ms 拒绝 / 77ms 通过且最大响应
时间 77ms）、恰好 85% 与恰好压线完成的边界，以及分析结论与独立仿真在
完整重复周期上的交叉验证。
