# snapshot-repo

本地 Maven SNAPSHOT 发布库（TypeScript）。由上层构建任务直接调用，只管理一个本地仓库：
元数据存于 SQLite（`repo.db`），制品存于本地目录（`artifacts/`）。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部依赖）
- `npm install && npm test` 即可构建并运行全部测试

## API

```ts
import { SnapshotRepository } from './src/index.js';

const repo = SnapshotRepository.open('/path/to/repo'); // 打开即自动崩溃恢复

// 1. 登记：调用方提供仓库内唯一的发布标识 + 清单
const { actualVersion, buildNumber } = repo.register('release-id-123', {
  groupId: 'com.example',
  artifactId: 'demo',
  version: '1.4-SNAPSHOT',          // 必须以 -SNAPSHOT 结尾
  timestampUtc: '20261004.091500',  // UTC，yyyyMMdd.HHmmss
  pom: { length: 1234, sha256: '...' },
  jar: { length: 567890, sha256: '...' },
});
// actualVersion = '1.4-20261004.091500-7'（构建号从 1 递增，永不复用）

// 2. 提交：两个本地源文件，长度与 SHA-256 必须匹配清单
repo.commit('release-id-123', '/path/to/a.pom', '/path/to/b.jar');

// 3. 查询当前快照（已完成发布中构建号最大者）
const cur = repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT');

// 4. 按实际版本读取（返回 Readable 流）
const stream = repo.readFile('com.example', 'demo', actualVersion, 'jar');

repo.close();
```

## 语义

- **幂等登记**：相同发布标识 + 相同清单重复登记返回原实际版本；清单任何字段不同抛
  `ManifestConflictError`。重开库后仍然成立。
- **整体可见**：制品先写入暂存区并 fsync，再通过一次目录级原子 rename 就位，
  最后才在 SQLite 标记完成。任何时刻都不存在“半份发布”。
- **崩溃恢复**：打开仓库时自动恢复——已就位的完整制品补记为完成；
  暂存区残留一律清除；未完成的登记与已分配的构建号保留，供重试收敛。
- **可重试**：提交校验失败（`CommitMismatchError`）不改变状态，可用正确文件重试；
  已完成发布的重复提交返回原结果，不生成新版本、不重复占用存储。
- **内存**：提交全程 1 MiB 缓冲流式处理，峰值内存增量远低于 64 MiB（有测试覆盖）。

## 目录结构

```
<repo>/
  repo.db                 # SQLite 元数据（releases + 构建号计数器）
  artifacts/
    staging/<hash>/       # 提交中的暂存目录（恢复时清除）
    final/<hash>/{pom,jar}# 已完成发布的制品（不可变）
```

## 测试

`npm test` 覆盖：登记中断与幂等/冲突重试、构建号不复用、提交各阶段中断
（暂存后、制品就位后）、恢复再次中断、旧登记晚完成不回退、历史版本可读、
字节级一致性与提交内存上限。崩溃场景通过 `test/crashers/` 子进程在钩子点
`process.exit` 模拟强制终止。
