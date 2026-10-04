# SentinelCore 本地文件隔离执行器

检测与人工审批完成后，调用方提交执行命令，由本执行器把文件从原文件区隔离到本地隔离区，或将其恢复。元数据存于 SQLite，文件内容存于本地隔离目录，两者位于同一文件系统。

## 要求

- Node.js >= 23.4（使用内置 `node:sqlite`，无需任何原生依赖或外部服务）

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { QuarantineExecutor } from './src/index.js';

const executor = new QuarantineExecutor({
  originalRoot: '/data/original',     // 原文件区
  quarantineRoot: '/data/quarantine', // 隔离区
  databasePath: '/data/metadata.sqlite',
});

// 仅当文件内容 SHA-256 匹配时才隔离；quarantineId 等于 commandId
const q = executor.quarantine(commandId, 'sub/report.bin', expectedSha256);
// q: { status: 'quarantined', quarantineId } | { status: 'not_found' } | { status: 'sha256_mismatch' }

// 恢复到原路径；原路径被占用（即使字节相同）时返回冲突并保留隔离内容
const r = executor.restore(commandId, quarantineId);
// r: { status: 'restored' } | { status: 'conflict' } | { status: 'quarantine_not_found' } | { status: 'already_restored' }

executor.close();
```

## 语义

- **幂等**：`commandId` 全局唯一。相同 `commandId` 与参数的重试返回首次确定的结果，不再触碰文件；`commandId` 配不同参数会抛错。
- **隔离**：摘要匹配才通过 `rename` 原子地移入隔离区；摘要不符时原文件保持不变。
- **恢复**：通过 `rename` 原子地发布到原路径，不会暴露半个文件；成功后隔离区不留该条目的内容或暂存文件。冲突结果一经确定即持久化，后续路径变化不影响该命令重试的返回。
