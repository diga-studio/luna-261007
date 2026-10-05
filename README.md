# training-material-ingest

培训素材的可恢复分块入库库（TypeScript）。素材内容存本地目录，元数据存 SQLite（Node.js 内置 `node:sqlite`，无原生依赖、无外部服务）。

## 构建与测试

```sh
npm install
npm test
```

`npm test` 会先 `tsc` 编译到 `build/`，再用 Node 内置测试运行器执行全部测试（含崩溃恢复与 100 MiB 内存用例）。要求 Node.js ≥ 22.5（`node:sqlite`），建议在 Node 24 上运行。

## API

```ts
import { TrainingMaterialStore } from "training-material-ingest";

const store = new TrainingMaterialStore("/var/lib/ingest"); // 打开即自动恢复

// 1. 登记上传：稳定标识 + 总长度 + 完整内容 SHA-256。重复登记幂等，不清空进度。
store.registerUpload({ uploadId: "video-001", totalSize: 3670016, sha256: "<64 hex>" });

// 2. 接收分块：序号从 0 开始，除最后一块外均为 1 MiB，可乱序。
//    同序号同内容幂等成功；同序号不同内容抛 ChunkConflictError，不替换、不破坏。
store.receiveChunk("video-001", 0, chunkBuffer);

// 3. 查询状态：只反映已完整接收并确认的分块。
const st = store.getStatus("video-001");
// { receivedChunks: [0, 2], receivedBytes, totalChunks, complete, filePath? }

// 4. 完成入库：分块齐全且拼接长度、摘要符合声明才成功。
//    重复调用返回同一成品路径；已完成素材不可再被改写。
const { filePath } = store.finalize("video-001");

store.close();
```

约束：素材非空、最大 100 MiB；`uploadId` 限字母数字开头的 `[A-Za-z0-9._-]`（≤128 字符）。上层串行调用，同一目录只由一个实例使用。

## 目录布局

```
<dir>/
  meta.sqlite3        # 元数据：上传声明、已确认分块、完成状态
  chunks/<id>/<seq>   # 已提交分块（完成入库后清理）
  final/<id>          # 成品文件
  **/*.tmp-*          # 写入中的临时文件（恢复时一律清除）
```

## 崩溃恢复设计

- 分块写入：临时文件 + `fsync` + 原子 `rename` + 目录 `fsync`，然后才登记 SQLite。半块永远不会被算作已接收。
- 若进程在 `rename` 之后、登记 SQLite 之前退出：重开时扫描分块目录，把磁盘上已提交的分块补登记回元数据，已确认进度不丢失。
- 完成入库：先拼接到成品临时文件并流式计算 SHA-256，校验长度与摘要通过后才原子 `rename` 为成品，再提交元数据，最后清理分块。
- 若进程在成品 `rename` 之后、元数据提交之前退出：重开时对成品重新校验摘要，相符则补标记完成，不符则删除——恢复结果只会是"可继续完成的上传"或"可完整读取的成品"。
- 重开时清除所有 `*.tmp-*` 临时文件及无主分块目录/成品文件，反复中断重试不会累积垃圾。
- 所有操作每次至多读写一个分块（1 MiB），处理 100 MiB 素材时新增峰值内存远低于 32 MiB（测试实测约 4 MiB）。

## 测试

- `test/basic.test.ts`：登记幂等与冲突、乱序/重复/冲突分块、状态准确性、完成幂等、完成后防改写、校验失败路径。
- `test/crash.test.ts`：用子进程在各崩溃点（分块/成品 的 tmpWritten/renamed/committed）SIGKILL 自杀，验证恢复语义；含累计 100 次中断/恢复/重试仍收敛到唯一成品且无临时文件残留。
- `test/memory.test.ts`：100 MiB 素材完整入库，逐字节校验成品，并断言新增峰值内存 < 32 MiB。
