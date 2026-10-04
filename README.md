# SentinelCore 本地文件隔离执行器

TypeScript 实现。元数据存 SQLite（Node 内置 `node:sqlite`，无原生依赖），文件内容保存在本地隔离目录。

## 构建与测试

```sh
npm install
npm test        # 编译 src+test 并运行 node:test 测试
npm run build   # 仅编译 src 到 dist/
```

要求 Node.js >= 22.5（内置 `node:sqlite`），开发环境 Node 24 验证通过。

## API

```ts
import { QuarantineExecutor } from "./src/index.js";

const executor = new QuarantineExecutor({
  originalRoot: "/path/to/original",   // 原文件区
  quarantineRoot: "/path/to/quarantine", // 隔离区（与原文件区同一文件系统）
  dbPath: "/path/to/meta.sqlite",
});

// 仅隔离内容摘要匹配的文件；quarantineId = commandId
executor.quarantine(commandId, "relative/path.bin", expectedSha256);
// => { status: "ok", quarantineId } | { status: "not_found" } | { status: "hash_mismatch" }

// 恢复到原路径；路径被占用（即使字节相同）返回 conflict 并保留隔离内容
executor.restore(commandId, quarantineId);
// => { status: "ok" } | { status: "conflict" } | { status: "not_found" }
```

## 语义

- 隔离/恢复均通过同一文件系统上的 `rename` 原子完成：不暴露半个文件，恢复后隔离区无残留。
- `commandId` 全局唯一：相同 commandId 的重试返回首次确定的结果，不再操作文件（含冲突结果）。
- 摘要不符时原文件保持不动。
