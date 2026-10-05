# marketing-automation

进程内营销自动化发送库（TypeScript）。由上层直接调用，状态保存在进程内，
使用调用方可推进的毫秒逻辑时钟，发送由调用方提供的异步模拟器执行。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `devDependencies` 中的 `typescript` / `@types/node`。

## API

```ts
import { MarketingAutomation, ManualClock } from './src/index.js';

const engine = new MarketingAutomation({
  clock,   // { now(): number }，调用方推进的逻辑毫秒时钟
  sender,  // async (req: SendRequest) => Promise<'success' | 'failure'>，可永不返回
});

await engine.submitEvent({ subscriberId, eventId, kind: 'consent' });
await engine.submitEvent({ subscriberId, eventId, kind: 'stop' });
await engine.submitEvent({
  subscriberId, eventId, kind: 'trigger',
  plan: [{ content: 'hello', delayMs: 0 } /* 1..5 步 */],
});

await engine.advanceQueue();        // 启动当前所有到期尝试，不等待回执
engine.getSubscriber(subscriberId); // 同意期 / 链 / 步骤 / 尝试记录
engine.getChain(chainId);
```

## 语义要点

- 事件按接纳顺序生效，以 `(subscriberId, eventId)` 永久去重；重放无任何效果，
  退订期间收到的触发也被记住，之后重放不会补发。
- 触发仅在当前已同意时创建发送链，链永远属于创建时的同意期。
- 首步从触发接纳时刻起算，后续步骤从前一步首次被接纳为成功的回执时刻起算。
- 调用模拟器即为一次尝试开始；开始后 45 秒未返回即超时（恰好 45 秒算迟到）。
  初次尝试外最多重试 3 次，分别在失败/超时后 1、5、30 分钟到期；
  失败与超时合计只消耗一次重试机会，迟到失败不再安排重试。
- 任一尝试的首次成功（含迟到成功）使步骤成功：取消未开始的重试，
  后续步骤只产生一次；已终止的链不因迟到成功复活。
- STOP 后旧同意期内未开始的尝试永久取消，已开始的尝试可返回并记录但不再推进链路；
  再次同意只允许新业务触发创建新链，旧链不能恢复。
- 只在 `advanceQueue()` 时开始新尝试，开始时间取当前时钟而非计划时间；
  已发生的尝试与回执记录及其所属同意期、链、步骤均可通过查询接口追溯。
