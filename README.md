# secure-notify

内部安全通知可靠投递库（TypeScript）。由上层以库的形式调用，无接口层；
队列状态持久化在 SQLite（Node 内置 `node:sqlite`），进程退出后重启可继续投递，
准确保留投递次数与阅读状态。通知正文由上层渲染完成后传入。

## 要求

- Node.js >= 22.5（依赖内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行（唯一开发依赖为 typescript）

## 使用

```ts
import { NotificationQueue, LocalReceiver } from "secure-notify";

// 本机接收方：独立持久化投递结果与收件箱消息
const receiver = new LocalReceiver({
  dbPath: "receiver.db",
  behavior: (id, attempt) => sendToLocalEndpoint(id, attempt),
});

const queue = new NotificationQueue({ dbPath: "queue.db", receiver });

queue.enqueue("alert-1", "<渲染后的正文>", nowMs); // 重复入队幂等
await queue.advance(nowMs);                        // 推进到期投递
queue.ackRead("alert-1");                          // 阅读确认（可重复、可先于成功回执）
queue.getStatus("alert-1");                        // { status, attempts, nextAttemptAt }
```

`nowMs` 为调用方提供的单调不减整数毫秒时间；退避边界完全由该时间驱动，便于测试。

## 语义

- 每条通知尝试序号从 1 开始，首次可立即投递，最多 5 次；第 1–4 次失败后，
  分别在该次结果**落地时间**之后等待 1、2、4、8 秒；第 5 次失败后停止。
- 状态机：`queued` → `delivered` → `read`，或 5 次失败后 `failed`。
  阅读确认一旦到达，任何后续投递结果或恢复处理都不会把状态降回。
- 接收方对同一 `(通知ID, 尝试序号)` 的重复调用返回首次落地结果及落地时间；
  成功时同一通知最多保存一条收件箱消息。
- 进程在任意阶段退出后重启：已落地但未确认的结果按原落地时间被采用；
  没有落地结果的中断不记失败、不额外消耗次数，以原尝试序号重投。

## 结构

- `src/types.ts` — 公共类型（`Receiver` 接口、`DeliveryResult`、状态）
- `src/queue.ts` — `NotificationQueue`：入队 / 推进 / 阅读确认 / 查询，SQLite 持久化
- `src/receiver.ts` — `LocalReceiver`：SQLite 持久化的本机接收方（结果 + 收件箱）
- `test/notify.test.ts` — 崩溃恢复、退避边界、阅读确认竞态等验收测试
