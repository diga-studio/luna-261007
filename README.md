# task26100780

图片生成批次的持久化账本：请求去重、逐张检查点、失败重放。不实现绘图模型，调用方提供 `render(requestId, index, prompt)`。

## 要求

- Node.js >= 22.18（使用内置 `node:sqlite` 与原生 TypeScript 类型擦除，无任何 npm 依赖）

## 使用

```sh
npm install   # 无依赖，立即完成
npm test      # node --test
```

```ts
import { ImageBatchLedger } from "./src/index.ts";

const ledger = new ImageBatchLedger({ dir: "./data" });
ledger.submit("req-1", "prompt with brand constraints", 4);
await ledger.runNext(async (requestId, index, prompt) => render(requestId, index, prompt));
ledger.replay("req-1"); // 仅对 failed 任务有效
const view = ledger.get("req-1"); // 仅 completed 时含 imagePaths
```

## 行为

- `submit`：同 requestId 同参数幂等返回原任务；参数不同则拒绝；不同 requestId 属不同批次。
- `runNext`：取最早 queued 任务，按 index 顺序生成，每张图片写盘后原子更新 SQLite 检查点；生成器抛错则任务进入 failed，保留已完成的检查点。
- `replay`：failed → queued，从未完成的 index 继续；其他状态为 no-op；已检查点的图片不会重新生成。
- `get`：返回状态与进度；只有 completed 才返回完整批次的图片路径。

## 存储布局

```
<dir>/ledger.sqlite   # tasks 与 images 元数据
<dir>/images/         # 每张图片一个文件（requestId 哈希 + index 命名）
```
