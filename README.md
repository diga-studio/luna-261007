# archive-notifier

档案合规通知的可靠投递与确认库。通知正文、收件人和重要程度由上层决定，
本模块只负责可靠投递、重试、崩溃恢复与回执确认；消息、尝试记录和回执
状态全部持久化在 SQLite 中（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { ArchiveNotifier } from "archive-notifier";

const notifier = new ArchiveNotifier({
  dbPath: "notifier.db",          // SQLite 文件路径，或 ":memory:"
  deliver: async (body, messageId, attemptId) => { /* 进程内投递 */ },
});

// 1. 提交通知（同一 id 重复提交为幂等 no-op，内容冲突会抛错）
notifier.submitNotification(
  { id: "retention-001", body: "...", recipient: "compliance@corp",
    notBefore: Date.UTC(2026, 0, 5, 9), critical: false },
  Date.now(),
);

// 2. 推进到期投递（传入单调不减的 UTC 毫秒时间戳；同一时刻串行执行）
await notifier.advance(Date.now());

// 3. 接收回执（引用该消息任一已开始尝试的 id 即有效）
notifier.submitReceipt(receiptId, attemptId, Date.now());

// 4. 查询
notifier.getNotification("retention-001");
notifier.listAttempts("retention-001");
```

## 语义要点

- 通知不会在 `notBefore` 之前投递；非关键通知只能在 UTC 每天 08:00（含）
  至 18:00（不含）开始投递，关键通知不受限。重启后的重放同样遵守。
- 每条通知首次投递后最多重试 3 次（共 4 次）。上一次投递调用已结束、
  距该尝试首次开始满 10 分钟且仍未确认，才开始下一次尝试；第 4 次满足
  同样条件后进入 `exhausted`。
- 每次新尝试在调用投递函数前已持久化、可查询。投递函数返回或抛异常都
  不代表确认，只有单独提交的有效回执才算确认。
- 崩溃时若投递调用的结束状态尚未保存，恢复后先用原尝试 id 和原首次开始
  时间重放该次尝试，不增加尝试次数；已保存结束状态的尝试不会立即重放。
- 有效回执在耗尽后到达仍转为 `confirmed`；确认后不再开始任何新投递或
  重放，进行中的调用允许结束但不会把消息改回未确认。
