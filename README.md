# snapshot-repo

Maven SNAPSHOT 本地发布库（TypeScript）。由上层直接调用，只管理一个本地仓库：
元数据存 SQLite（Node.js 内置 `node:sqlite`，无原生依赖），制品存本地目录。

## 要求

- Node.js >= 22.5（内置 `node:sqlite`；开发验证使用 Node 24）
- 无运行时依赖；`npm install` 只安装 TypeScript 与类型定义

## 构建与测试

```sh
npm install
npm test        # 编译 src 与 test 并运行 node:test 测试
npm run build   # 仅编译库到 dist/
```

## API

```ts
import { SnapshotRepository } from "snapshot-repo";

const repo = SnapshotRepository.open("/path/to/repo");

// 1. 登记：分配实际版本。相同标识+相同清单重复登记返回原实际版本；
//    相同标识不同清单抛 PublishIdConflictError。
const info = repo.register("build-2026-10-04-0007", {
  groupId: "com.example",
  artifactId: "demo",
  version: "1.4-SNAPSHOT",          // 必须以 -SNAPSHOT 结尾
  timestampUtc: "20261004.091500",  // yyyyMMdd.HHmmss（UTC）
  files: {
    pom: { length: 1234, sha256: "..." },
    jar: { length: 56789, sha256: "..." },
  },
});
// info.actualVersion === "1.4-20261004.091500-1"（构建号从 1 递增，永不复用）

// 2. 提交：校验长度与 SHA-256，两个文件整体可见；重复提交返回原结果。
repo.commit("build-2026-10-04-0007", "/path/to/app.pom", "/path/to/app.jar");

// 3. 查询当前快照（已完成发布中构建号最大者）
const snap = repo.currentSnapshot("com.example", "demo", "1.4-SNAPSHOT");

// 4. 按实际版本读取已完成发布的文件
const pom: Buffer = repo.readFile(info.actualVersion, "pom");
const jar: Buffer = repo.readFile(info.actualVersion, "jar");

repo.close();
```

## 崩溃一致性设计

- **登记**：单条 SQLite 事务插入，构建号取自该坐标历史最大号 + 1，已分配号码永不复用。
- **提交**：先流式校验两个源文件（1 MiB 缓冲，提交期内存增量远小于 64 MiB），
  再各自经暂存区 `fsync` + 原子 `rename` 就位，最后单条 SQLite 更新标记完成。
  未完成发布对外完全不可见，因此不存在"半份发布"。
- **恢复**（每次 `open` 时执行，可重入）：清空暂存区；删除所有未完成发布的制品字节；
  登记记录与构建号保留，供按原标识重试，收敛到同一实际版本。
- **当前快照**：只取已完成发布中构建号最大者，先登记晚完成不会导致回退。

测试通过子进程 `SIGKILL` 模拟登记后、提交记录写入前后、恢复过程中的进程中断，
覆盖验收要求的全部场景（见 `test/crash.test.ts`）。
