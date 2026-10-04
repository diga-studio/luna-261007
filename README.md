# waitlist-engine

供场馆多个活动赛道共享使用的团队报名候补引擎。进程内 TypeScript 库，串行调用，
无界面、无鉴权、无持久化。设计细节见 [DESIGN.md](DESIGN.md)。

## 使用

```ts
import { WaitlistEngine } from "./src/index.ts";

const engine = new WaitlistEngine({
  capacities: [4, 2],        // 两条赛道，容量分别为 4 和 2
  conflicts: [[0, 1]],       // 赛道 0 与 1 互相冲突（同赛道恒自冲突）
});

const id = engine.register(0, ["alice", "bob"]); // 返回报名标识（即创建序号）
engine.withdraw(id);                              // 撤回候补或已录取报名
const snapshot = engine.inspect();                // 读取状态，不改变引擎
```

每次 `register`/`withdraw` 返回前，引擎已完成确定性递补：反复录取当前可整体录取
且创建序号最小的候补，直到不存在可录取候补。

## 运行要求与命令

- Node.js 不低于 22.6（利用内置 TypeScript 类型擦除与 `node:test`，零第三方依赖）。
- `npm install`：无需安装任何依赖，直接成功。
- `npm test`：运行全部自动化测试（确定性场景、随机对照、10 万规模测试）。
- `npm run typecheck`：可选；需自行安装 `typescript`（5.5 及以上），
  工程内置 `node-shims.d.ts`，无需 `@types/node`。
