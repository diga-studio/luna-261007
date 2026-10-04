# session-reassembly

移动行为事件的进程内存会话重组库（TypeScript），由上层直接调用，事件与派生结果只保存在进程内存中。

## 能力

- `writeBatch(records)`：批量写入完整事件记录；同 ID 覆盖旧记录（可改时间戳和屏幕），重复写入不增加事件数。
- `getSessionSummary(eventId)`：查询指定事件所在会话的摘要（起止时间、时长、事件数、入口/出口屏幕）。
- `getSessionEvents(eventId)`：读取该会话的完整事件序列（同屏幕连续事件不折叠）。

## 规则

- 每个用户的有效事件按时间戳升序、同毫秒按事件 ID 的 ASCII 字典序排列。
- 相邻事件间隔严格小于 30 分钟属于同一会话，达到或超过 30 分钟切开。
- 每批写入结束后，对受影响用户的有效记录集合重新排序、重新划分会话，
  结果与批内记录顺序无关，天然支持乱序补传与修订（拆分/合并）。

## 使用

```ts
import { SessionStore } from "session-reassembly";

const store = new SessionStore();
store.writeBatch([
  { eventId: "e1", userId: "u1", timestampMs: 1700000000000, screen: "Home" },
]);
console.log(store.getSessionSummary("e1"));
console.log(store.getSessionEvents("e1"));
```

## 构建与测试

```sh
npm install
npm test
```

`npm test` 会先用 `tsc` 编译 `src/` 与 `test/` 到 `dist-test/`，再用 Node 内置测试运行器执行。

> 注：`.local/` 与 `tsconfig.local.json` 仅用于无网络环境下的本机离线验证，
> 正常交付流程（`npm install && npm test`）不依赖它们。
