# consent-merge

同意选择合并库（TypeScript + SQLite），供上层横幅、渐进弹窗和偏好中心调用。
不提供接口层，以库的形式被引入；数据持久化到 SQLite 文件。

## 能力

- `getSnapshot(userId)`：读取当前快照（完整四个类别选择 + 修订号）。新用户初始全部拒绝、修订号 0。
- `submitChoices(userId, command)`：提交部分选择，命令携带用户当时看到的 `baseRevision`。
- `withdrawAll(userId, command)`：一键撤回，四个类别无条件全部设为拒绝。
- `getHistory(userId)`：读取审计历史（不可改写、不可删除的同意事件，按修订号升序），可独立还原任一修订号的完整选择。

## 一致性规则

- 部分选择只影响明确提交的类别；拒绝选择永不因快照陈旧而冲突。
- 授权选择仅在其基准修订号之后没有成功命令涉及该类别时才被接受；同一类别即使最终值未变，只要期间有成功命令涉及它，旧快照授权仍冲突。
- 一条命令中任一授权类别冲突，整条命令拒绝（含其中的拒绝选择）；否则全部一起生效。
- 每条成功写入恰好增加一个修订号并追加一个同意事件（即使值未变化）；冲突命令不产生任何副作用。
- 两种写入命令都带 `requestId`：同一用户内重复投递返回首次处理的结果与快照，不重新执行，重启后依然成立。

## 并发与性能

- 底层 `node:sqlite` 为同步驱动，同一进程内多个实例的调用天然串行，结果可按调用完成顺序线性化；读取不会混合不同修订号的类别值。
- 单用户 10 万条事件后，连续读取快照 100 次总耗时远低于 2 秒（自动化性能测试覆盖）。
- 支持全部调用结束后的正常关闭与重启；不要求崩溃恢复（`synchronous=NORMAL`）。

## 使用

```ts
import { ConsentService } from "consent-merge";

const service = new ConsentService({ path: "consent.db" }); // 或 ":memory:"

const snapshot = service.getSnapshot("user-123");

const result = service.submitChoices("user-123", {
  requestId: "req-abc",
  baseRevision: snapshot.revision,
  choices: { cookies: "granted", emailMarketing: "rejected" },
});
// result: { status: "applied", snapshot } | { status: "conflict", snapshot, conflicts }

service.withdrawAll("user-123", { requestId: "req-def" });

const history = service.getHistory("user-123");

service.close();
```

## 构建与测试

```sh
npm install
npm test        # 编译 TypeScript 并运行全部测试（含并发与性能测试）
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>= 22.5，使用内置 `node:sqlite`）与 devDependencies 中的
`typescript` / `@types/node`，不需要 Docker、数据库服务或任何监听端口。
