# secure-notify

内部安全通知投递库（TypeScript，无接口层），队列状态持久化在 SQLite（Node 内置 `node:sqlite`，无原生/外部依赖）。

## 使用

```ts
import { NotificationQueue, LocalReceiver } from "secure-notify";

let now = 0; // 调用方提供的单调不减业务时钟（整数毫秒）
const receiver = new LocalReceiver("inbox.db", { now: () => now });
const queue = new NotificationQueue("queue.db", receiver);

queue.enqueue("alert-1", "已渲染的通知正文", now); // 重复入队是 no-op
await queue.advance(now);                          // 推进到期投递（首次可立即投递）
queue.ackRead("alert-1");                          // 阅读确认，幂等且不可逆
queue.get("alert-1");                              // { status, attemptCount, nextAttemptAt, ... }
```

## 语义

- 每条通知最多 5 次尝试；第 1–4 次失败后分别在该次**结果落地时间**后等待 1/2/4/8 秒；第 5 次失败进入 `failed`。
- 状态机：`queued` → `delivered` → `read`，或 5 次失败后 `failed`。`read` 一经确认不可降级。
- 接收方按 `(通知ID, 尝试序号)` 幂等持久化结果与首次落地时间；成功时保存消息，同一通知最多一条。
- 进程在任意阶段退出后，重启并调用 `advance(now)` 即可恢复：已落地结果被采纳（按原落地时间计算退避），未落地的中断不消耗尝试次数。

## 构建与测试

```sh
npm install
npm test
```

要求 Node.js ≥ 22.13（内置 `node:sqlite`）。所有业务时间由调用方以整数毫秒传入，退避边界可在测试中直接验证，无需真实等待。
