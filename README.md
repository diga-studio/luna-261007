# image-batch-ledger

图片生成批次的持久化账本：请求去重、逐张检查点、失败重放。不实现绘图模型；调用方注入 `render(requestId, index, prompt)` 异步函数，返回一张图片的 `Uint8Array` 或抛错。

- 图片字节保存在 `<dir>/images/`，任务与结果元数据保存在 `<dir>/ledger.db`（SQLite，使用 Node 内置 `node:sqlite`，无原生依赖）。
- 状态机：`queued` → `processing` → `completed` 或 `failed`。`failed` 任务只能显式 `replay` 重新入队。

## API

- `submit(requestId, prompt, count)`：同 requestId 且参数相同则幂等返回原任务；参数不同抛 `ConflictError`，不覆盖原任务；不同 requestId 即使参数相同也属于不同批次。
- `runNext(render)`：取一个 `queued` 任务，按 index 从 0 顺序生成，每张图片落盘并写入 SQLite 检查点后再开始下一张；生成器抛错时任务进入 `failed`，保留已有检查点；没有队列任务时返回 `undefined`。
- `replay(requestId)`：仅对 `failed` 任务重新入队，从未完成的 index 续跑，已检查点的图片不会重新生成；对 `queued`、`processing`、`completed` 任务是无操作。
- `get(requestId)`：返回任务状态；仅 `completed` 状态才包含完整批次的 `imagePaths`。

## 构建与测试

要求 Node.js >= 22.5（使用内置 `node:sqlite` 与 `node:test`）。唯一开发依赖是 `typescript`。

```sh
npm install
npm test
```
