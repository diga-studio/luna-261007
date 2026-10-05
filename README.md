# training-material-store

培训素材的可恢复分块入库库（TypeScript）。素材内容存本地目录，元数据存 SQLite（Node.js 内置 `node:sqlite`，无原生依赖、无外部服务）。

## 要求

- Node.js >= 22.5.0（依赖内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试（构建用 `typescript`，类型用 `@types/node`，均为 devDependencies）

## API

```ts
import { TrainingMaterialStore } from 'training-material-store';

const store = TrainingMaterialStore.open('/var/lib/materials'); // 打开即自动恢复

store.register({ uploadId, totalSize, sha256 });  // 登记上传（幂等，重复登记不清进度）
store.receiveChunk(uploadId, index, data);        // 接收分块（可乱序、可重复）
store.getStatus(uploadId);                        // 查询状态（只含已完整接收的分块）
const { artifactPath } = store.finalize(uploadId);// 完成入库（幂等，返回唯一成品路径）
store.close();
```

- `uploadId`：1–200 字符，字符集 `[A-Za-z0-9._-]`，首字符须为字母或数字。
- `totalSize`：1 字节 ~ 100 MiB 的整数；`sha256`：完整内容的 64 位小写十六进制摘要。
- 分块从 0 编号，除最后一块外均为 1 MiB，最后一块为剩余长度；长度不符抛 `InvalidChunkError`。
- 同一序号重复提交相同内容为成功空操作；提交不同内容抛 `ChunkConflictError`，原块与其他进度不受影响（完成后依然如此）。
- 同一 `uploadId` 重复登记时若 `totalSize`/`sha256` 与首次声明不一致，抛 `DeclarationMismatchError`。
- 分块未齐全时 `finalize` 抛 `UploadIncompleteError`；拼接结果长度或摘要不符抛 `DigestMismatchError`。

## 目录布局

```
<root>/
  meta.sqlite        元数据（uploads 与 chunks 两张表，WAL + synchronous=FULL）
  chunks/<id>/<n>    已确认分块（临时文件 fsync 后原子 rename 到位，再落库）
  artifacts/<id>     成品（全量校验通过后原子 rename 到位，再更新库状态）
  tmp/               所有写入中的临时文件，打开库时整体清空
```

## 崩溃恢复语义

- 分块先写 `tmp/` 并 fsync，原子 rename 进 `chunks/` 后才插入数据库；`receiveChunk` 返回成功即持久。
- 打开库时自动恢复：清空 `tmp/`；把"已 rename 但未落库"的分块补登进库；把"已生成成品但未标记完成"的上传标记为完成；删除无主的分块目录与成品文件。
- `finalize` 中途退出只会留下两种状态之一：可继续完成的上传，或可完整读取的成品；重试最终收敛到唯一成品 `artifacts/<uploadId>`。
- 已完成素材不可改写；重复 `finalize` 返回同一路径，不产生第二个成品。
- 内存：接收路径直接写调用方传入的 Buffer；拼接路径复用单个 1 MiB 读缓冲，处理 100 MiB 素材新增峰值内存远低于 32 MiB。

## 测试

```
npm test
```

- `test/basic.test.ts`：乱序 + 重复 + 冲突分块最终逐字节一致；登记幂等；参数校验。
- `test/crash.test.ts`：子进程在接收分块 / 完成入库期间被 SIGKILL，重开后已确认分块不丢失、成品可完整读取；100 次中断/恢复/重试后仍只有一个成品且无临时文件残留。
- `test/memory.test.ts`：100 MiB 素材完整入库，模块新增峰值内存 < 32 MiB。
