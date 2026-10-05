# syscall-baseline

进程级系统调用序列基线库：为每个工作负载在学习期（首次观测起 60 分钟）内
建立「进程实例调用序列的全部非空连续子串」基线，学习期结束后基线永久冻结，
对检测期的每个 call 输出最长匹配后缀长度 `m` 与异常判定（`m < min(k, 8)`）。

## API

- `openWorkload(workloadId, t0)`：建立工作负载，`t0` 为首次观测时间（毫秒）。
- `ingest(workloadId, events)`：接收事件（`start` / `call` / `exit`，call 带
  系统调用编号），返回该批次中每个检测期 call 的 `{ m, k, anomaly }`。
- `resetAll()`：清空全部工作负载（主要用于测试）。

语义要点：

- 时间严格小于 `t0 + 3600000` 的 call 参与学习；恰好位于边界的 call 属于检测期。
- 子串不跨进程、不跨实例（pid 复用不继承旧序列）、不跨工作负载。
- 跨越学习边界的存活进程保留此前的调用上下文。
- 检测期出现的新序列不会反过来进入基线。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js 与 `package.json` 中声明的 devDependencies（typescript、
@types/node），测试使用 Node 内置 test runner，无需任何外部服务。
