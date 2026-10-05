# visual-regression-baseline

供上层调用的视觉回归基线库（单个测试组）。元数据存 SQLite（Node 内置
`node:sqlite`），PNG 文件存在本地目录（内容寻址），无接口层、无外部服务。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js（>= 23.4，内置 `node:sqlite`）与 npm；`typescript` 是唯一开发依赖。

## API

```ts
import { VisualRegressionLibrary } from 'visual-regression-baseline';

const lib = new VisualRegressionLibrary({ dir: './vr-data', maxRetainedRuns: 10 });
```

- `submitRun(screenshots: { name, png }[]): string`
  提交一组具名截图，返回 run id。提交成功的瞬间同步固定当时已发布的整套
  基线，比较在后台执行，之后的批准不影响本次结果。
- `getRun(runId): RunInfo | null`
  查询 run：处理中（`status: 'processing'`）或完整结果（`status:
  'completed'`，含每张图的匹配率与整体是否通过）。完整结果不再变化；
  被清理的 run 返回 `null`。
- `getRunImage(runId, name): { name, screenshot, baseline } | null`
  取回本次截图与实际使用的（提交时固定的）基线图片。
- `getBaseline(): { version, names }`
  当前基线版本与包含的页面名。初始版本为 0，内容为空。
- `approveBaseline(runId, names, expectedVersion): ApproveResult`
  从已完成且仍保留的 run 中选部分截图发布为新基线。版本相符才整体发布，
  版本加 1，仅替换选中名字；版本冲突或任何校验失败都不会部分生效，也不
  自动重试。
- `waitForIdle(): Promise<void>`
  等待后台比较、超限记录清理与无引用图片回收全部完成。
- `close(): Promise<void>` 等待后台工作结束后关闭数据库。

## 语义

- 匹配率 = RGB 三通道完全相等的像素数 / 总像素数 × 100；所有图片
  匹配率 ≥ 98% 才通过，缺少同名基线视为失败。
- 已完成 run 超出 `maxRetainedRuns` 时按提交顺序清理最老者；未完成 run
  不计入上限也不会被清理。
- 当前基线、未完成 run 及任一保留结果引用的图片始终可读；其余图片由
  后台 GC 自动从磁盘回收。
