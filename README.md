# archival-notification-delivery

档案通知可靠投递库（TypeScript + SQLite）。上层负责生成通知内容，本库只负责可靠投递与确认。

## 安装与测试

```sh
npm install
npm test
```

只依赖 Node.js 内置模块（`node:sqlite`、`node:test`），开发依赖仅 `typescript` 与 `@types/node`。

## API

```ts
import { createNotificationService } from './src/index.js';

const svc = createNotificationService({
  dbPath: 'notifications.db',
  deliver: (body, messageId, attemptId) => { /* 进程内投递 */ },
});

// 1. 提交通知（同一 id 重复提交为幂等；内容不一致会抛错）
svc.submitNotification({ id, body, recipient, notBefore, critical });

// 2. 推进到期投递（now 为上层提供的单调不减 UTC 毫秒时间戳）
await svc.advance(Date.now());

// 3. 接收回执（引用该消息任一已开始尝试的 id；重复提交无额外效果）
svc.submitReceipt(messageId, attemptId);

// 4. 查询
svc.getNotification(id);   // { id, body, recipient, notBefore, critical, status }
svc.listAttempts(id);      // [{ id, messageId, seq, firstStartedAt, endedAt, endError }]
```

## 语义

- 通知状态：`active` → `confirmed`（收到有效回执）或 `exhausted`（4 次尝试均未确认）。
- 非关键通知仅在 UTC 每天 08:00（含）至 18:00（不含）开始投递；关键通知不受限。
- 首次投递后最多重试 3 次（共 4 次）。下一次尝试要求：上一次投递调用已结束、
  距其首次开始满 10 分钟、仍未确认；从实际开始时刻重新计时。
- 投递函数正常或异常结束都不代表确认，只有单独提交的有效回执才算确认。
- 崩溃恢复：调用结束状态未保存的尝试，恢复后按原 attempt id 与首次开始时间重放，
  不增加尝试次数；已保存结束状态的尝试不会因重启立即重放。
- 同一时刻最多一次 `advance`；回执保存不阻塞于在途投递调用。
