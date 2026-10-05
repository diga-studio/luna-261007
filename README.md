# rolling-patch-release

滚动补丁发布库（TypeScript）：由上层调度器调用，发布状态持久化到 SQLite（Node 内置 `node:sqlite`，无外部服务依赖）。

## 能力

- `createPlan({ patchId, endpointIds, now })`：创建发布计划。目标端点固定并去重；同时只允许一个活动计划。在途上限为 `max(1, floor(目标数 / 10))`。
- `claimInstructions(now)`：领取安装指令。返回即占用名额；有可派发目标时补满空闲名额，不被其他端点的冷却/在途阻塞。同一指令 30 秒内不可重复领取，满 30 秒可重投（标识不变、次数不增、名额不另计）。
- `reportFeedback(attemptId, status, now)`：投递执行反馈。进度只前进不回退；最先接受的终态固定结果；首次失败后冷却 15 分钟（重复失败不推迟）；每端点最多 4 次有效尝试（初始 + 3 次重试）。
- `getProgress()`：查看发布进度（在途数、各状态计数、每端点尝试情况）。

所有期限按调用方传入的单调递增 UTC 毫秒时间计算，不做真实等待。

## 构建与测试

要求 Node.js >= 22.5（内置 `node:sqlite`）。

```sh
npm install
npm test
```
