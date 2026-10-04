# task26100703

RTOS 任务配置准入分析库。上层在向农业设备（灌溉控制器 / 自主农机）下发配置前调用，
对候选任务配置给出可解释的准入结论。候选配置与分析结果仅保存在内存，无接口层。

## 模型假设

- 单核、固定优先级、完全抢占的周期任务；优先级数字越小越优先，且互不重复。
- 所有任务在时刻 0 同时首次释放，此后严格按各自周期释放。
- 每个实例都使用声明的最坏执行耗时；不考虑阻塞、中断、释放抖动与调度开销。
- 旧实例未完成时新实例仍正常释放，不合并、不丢弃；超时实例继续执行至完成。
- 所有时间参数为正整数微秒；相对截止期限允许大于周期。

## 判定规则

1. CPU 总负载（各任务 `worstCaseExecutionTime / period` 之和，用 BigInt 有理数精确计算）
   超过 85% 直接拒绝；恰好 85% 允许继续检查。
2. 通过精确的事件驱动调度模拟检查截止期限：模拟持续至调度状态在超周期边界上重复，
   并将该稳态窗口内释放的实例全部运行到完成，因此结论覆盖无限持续运行中的所有实例，
   包括同一任务多实例积压的情况。恰好在截止时刻完成算成功。

## 结果

- `accepted`：给出各任务在所有实例上的最大响应时间。
- `rejected-deadline`：负载合格但存在超时，给出一个真实超时实例
  （任务标识、释放时刻、绝对截止时刻、实际完成时刻）。
- `rejected-utilization`：仅说明负载超限原因。

## 使用

```ts
import { analyzeConfig } from "rtos-admission-analysis";

const result = analyzeConfig({
  tasks: [
    { id: "control", priority: 0, worstCaseExecutionTime: 50_000, period: 100_000, relativeDeadline: 100_000 },
    { id: "inference", priority: 1, worstCaseExecutionTime: 26_000, period: 75_000, relativeDeadline: 77_000 },
  ],
});
```

## 构建与测试

```sh
npm install
npm test
```

测试包含题目给定场景（76ms 拒绝 / 77ms 通过且最大响应时间 77ms）、恰好 85% 负载、
恰好截止时刻完成等边界，以及与覆盖完整超周期的独立朴素模拟的交叉验证。
