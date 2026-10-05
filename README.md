# consent-merge

同意选择合并库（TypeScript + SQLite），供上层横幅、渐进弹窗和偏好中心调用。

## 能力

- `getSnapshot(userId)`：读取当前快照（完整选择 + 修订号），初始全部拒绝、修订号 0。
- `submitPartialChoice(command)`：提交部分选择，携带用户当时看到的 `baseRevision` 与 `requestId`。
- `withdrawAll(userId, requestId)`：一键撤回，四类全部设为拒绝。
- `getAuditHistory(userId)`：读取只增同意事件历史，可独立还原任一修订号的完整选择。

## 合并规则

- 拒绝选择永不冲突；授权选择仅当其基准修订号之后没有成功命令涉及该类别时才被接受。
- 一条命令中任一授权类别冲突，整条命令拒绝（含其中的拒绝选择），不增修订号、不追加事件。
- 每条成功写入恰好增加一个修订号并追加一个不可改写事件，即使选择值未变化。
- 相同 `requestId` 的重复投递返回首次处理的结果与快照，跨重启有效。

## 运行

需要 Node.js >= 22.6（使用内置 `node:sqlite` 与 TypeScript 类型擦除）。

```sh
npm install
npm test
```

`npm test` 只依赖 Node 本身；`npm run typecheck` 使用 devDependencies 中的 TypeScript 做类型检查。
