# task26100773

滚动补丁发布库（TypeScript + SQLite）。由上层调度器驱动：库不读真实时钟、不启动任何后台任务，
所有期限都按调用方传入的单调递增 UTC 毫秒时间计算；发布状态持久化在 SQLite 中。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生编译依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 能力

- `createPlan({ planId, patchId, endpointIds })`：创建发布计划。目标集合创建时去重并固定；
  同时只允许一个活动计划；在途上限为目标数的 10% 向下取整、最少 1。
- `claim(now)`：领取安装指令。返回即占用名额；同一指令 30 秒内不会重复领取，
  满 30 秒后原标识重投（尝试次数不增、名额不另计）；有可派发目标时补满空闲名额，
  不被其他端点的冷却或在途状态阻塞。
- `feedback(attemptId, status, now)`：接收执行反馈。进度（downloading/installing）单调推进不可回退；
  最先接受的终态（succeeded/failed/rolled_back）固定尝试结果；失败后冷却 15 分钟（到期时刻即可派发），
  重复失败不推迟冷却；每端点最多 4 次有效尝试（初始 1 次 + 重试 3 次）。
- `progress()`：查看当前（或最近一次）计划的发布进度。

## 使用

```ts
import { RollingRelease } from 'rolling-patch-release';

const release = new RollingRelease('release.db');
release.createPlan({ planId: 'plan-1', patchId: 'patch-2026-10', endpointIds: ['ep01', 'ep02'] });

for (const ins of release.claim(Date.now())) {
  // 将 ins（attemptId/endpointId/patchId）交给执行方；重复指令只回送已有进度或结果
}
release.feedback('plan-1:ep01:1', 'downloading', Date.now());
console.log(release.progress());
release.close();
```

## 开发

- `npm run build`：编译到 `dist/`
- `npm test`：构建并运行 `test/` 下的全部测试
