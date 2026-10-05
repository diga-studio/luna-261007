# marketing-automation

进程内营销自动化发送库（TypeScript，零依赖）。由上层直接调用，状态保存在进程内。

## 运行要求

- Node.js >= 22.18（利用内置 TypeScript 类型擦除直接运行 `.ts`，无需编译步骤）
- `npm install` 后 `npm test` 即可运行全部测试（无任何第三方依赖）

## 核心概念

- **同意期（epoch）**：订阅者初始未同意。从未同意/已退订转为同意时开启新同意期；已同意时重复同意不换期。每条发送链永远属于创建它的同意期。
- **事件去重**：`subscriberId + eventId` 组合永久去重。同一事件重放（包括退订期间收到的业务触发、旧 STOP、旧同意）不产生新效果。
- **发送链（chain）**：已同意时接纳业务触发创建，含 1~5 步。首步从触发接纳时刻起算，后续步骤从前一步首次成功回执时刻起算，顺序执行。
- **尝试（attempt）**：调用一次模拟器即一次尝试。45 秒未返回即超时（超时时刻固定为开始后 45 秒，恰好 45 秒返回算迟到）。初次尝试外最多重试 3 次，分别在失败/超时后 1、5、30 分钟到期。失败与超时合计只消耗一次重试机会。
- **迟到回执**：迟到成功在步骤未成功/终止且同意期有效时仍使步骤成功（只产生一次后续步骤）；迟到失败不再安排重试；已终止的链不因迟到成功复活。
- **STOP**：永久取消当前同意期所有未开始的尝试；已开始的尝试允许返回并记录，但不产生重试或后续步骤。再次同意只影响新触发创建的新链。

## API

```ts
import { LogicalClock, MarketingAutomation } from './src/index.ts';

const clock = new LogicalClock();          // 调用方可推进的毫秒逻辑时钟
const engine = new MarketingAutomation(
  async (req) => Math.random() < 0.9 ? 'success' : 'failure', // 发送模拟器
  clock,
);

await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
await engine.submitEvent({
  kind: 'trigger', subscriberId: 'u1', eventId: 't1',
  plan: [{ content: '欢迎', delayMs: 0 }, { content: '催单', delayMs: 86_400_000 }],
});

clock.advance(1_000);
await engine.advanceQueue();               // 启动当前所有到期尝试，实际开始时间为当前时刻

engine.getChains('u1');                    // 查询链路（含同意期、步骤状态）
engine.getAttempts(chainId);               // 查询尝试记录（含超时、迟到回执）
```

- `submitEvent(event)`：接纳同意 / STOP / 业务触发事件，按接纳顺序生效并去重。
- `advanceQueue()`：先结算已到 45 秒的超时，再启动所有到期尝试；返回 `{ startedAttempts, timedOutAttempts }`。
- `getChains(subscriberId?)` / `getAttempts(chainId)`：返回快照，可追溯每次尝试所属的同意期、链与步骤。

## 并发与性能

所有状态变更同步原子完成（模拟器调用不等待返回），50 路并发提交/推进不会重复调用同一尝试或重复产生后续步骤；模拟器永不返回时，退订、再次同意、其他订阅者发送与队列推进均不被阻塞。支持 10000 条未结束链（见 `test/scale.test.ts`）。

## 测试

```sh
npm test
```

覆盖：同一触发并发重放与队列并发推进（发送次数与唯一尝试数一致）、超时重试与迟到成功/失败交错（后续步骤最多一次、重试次数正确）、回执晚于 STOP 及再次同意（旧链永不续发、新链正常执行、重放旧事件不改变新同意期）、10000 链规模。
