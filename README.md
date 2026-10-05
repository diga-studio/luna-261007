# visual-regression-baseline

供上层调用的视觉回归基线库（单个测试组）。元数据存 SQLite（`node:sqlite`），
PNG 文件按内容寻址存放在本地目录，无接口层、无外部服务依赖。

## 要求

- Node.js >= 22.13（内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试

## 能力

```ts
import { VisualRegressionBaseline } from 'visual-regression-baseline';

const lib = new VisualRegressionBaseline({ dir: './data', maxRetainedRuns: 5 });

// 1. 提交测试 run：固定当时已发布的整套基线，比较在后台执行
const runId = lib.submitRun([{ name: 'home', png: pngBuffer }]);

// 2. 查询 run 及其图片：处理中状态或完整（不可变）结果
const info = lib.getRun(runId);            // processing | completed
const images = lib.getRunImages(runId);    // 本次截图 + 实际使用的基线图片

// 3. 批量批准基线：携带预期版本，版本相符才整体发布（版本 +1）
const newVersion = lib.approve(runId, ['home'], expectedVersion);

// 4. 等待后台工作结束：比较、超限记录清理、无引用图片回收
await lib.waitForIdle();
```

## 语义

- 匹配率 = RGB 三通道完全相等的像素数 / 总像素数 × 100；全部图片 ≥ 98% 才通过，
  缺少同名基线视为失败。
- 批准是乐观并发控制：版本冲突抛 `VersionConflictError`，不自动重试；
  任何批准失败都不会留下部分生效（单事务提交）。
- 已完成 run 超出 `maxRetainedRuns` 时按提交顺序清理最老者；未完成 run 不计入、
  不可清理。被清理的 run 不可再查询，但其图片若仍被当前基线或其他 run 固定的
  比较基线引用，则保留可读；其余图片由 GC 自动回收。

## 结构

- `src/library.ts` — 主类：提交、查询、批准、后台队列（比较/清理/GC）
- `src/db.ts` — SQLite schema
- `src/images.ts` — 内容寻址图片存储与引用回收
- `src/png.ts` — 纯 TS PNG 编解码（8-bit RGB/RGBA）与匹配率计算
- `test/library.test.ts` — 真实 PNG 的端到端场景测试
