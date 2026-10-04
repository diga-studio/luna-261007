# task26100732

移动行为事件的进程内存会话重组库（TypeScript）。

## 使用

```ts
import { SessionStore } from "./src";

const store = new SessionStore();
store.writeBatch([
  { eventId: "e1", userId: "u1", timestampMs: 1700000000000, screen: "home" },
]);
store.getSessionSummary("e1"); // 会话摘要：时长、事件数、入口/出口屏幕等
store.getSessionEvents("e1");  // 会话内按序排列的完整事件序列
```

- 同一用户的有效事件按时间戳升序、同毫秒按事件 ID 的 ASCII 字典序排列；
  相邻事件间隔达到或超过 30 分钟即切开会话。
- 同 ID 的后续写入覆盖旧记录（可改时间与屏幕），重复写入不增加事件数；
  每次批量写入后的查询结果与对当前有效记录集合重新排序、重新划分完全一致。

## 构建与测试

```sh
npm install
npm test
```
