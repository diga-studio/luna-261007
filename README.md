# task26100741

进程级系统调用序列基线库（TypeScript）：为每个工作负载在学习期
（首次观测起 60 分钟）内建立"进程实例调用序列的全部非空连续子串"
基线，学习期结束后基线永久冻结；检测期内对每个 call 计算当前进程
实例完整调用序列的最长后缀匹配长度 `m`，当 `m < min(k, 8)`（`k` 为
当前实例累计调用数）时判为异常。

## API

```ts
import { createBaseline } from "./src/index";

const baseline = createBaseline();
baseline.openWorkload("w1", t0);        // t0: 首次观测时间（毫秒）
const verdicts = baseline.ingest("w1", events); // 每个检测期 call 一个判定
```

- 事件类型：`start` / `call`（带 `call` 系统调用号）/ `exit`，时间戳非降序。
- `exit` 后 pid 可复用，新实例不继承旧序列；不同进程事件可任意交错。
- 时间严格小于 `t0 + 3600000` 的 call 参与学习；恰好位于边界的 call 属于检测期。
- 判定结果：`{ pid, call, t, m, k, anomalous }`。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 devDependency 中的 `typescript`；测试使用
Node 内置的 `node:test` 运行器，`types/node-shims.d.ts` 提供了所需的
最小类型声明，因此不需要 `@types/node`。

## 结构

- `src/types.ts` — 事件与判定结果的类型定义
- `src/baseline.ts` — 基线库实现（子串集合增量维护，检测期冻结）
- `test/reference.ts` — 小规模暴力枚举子串的参考实现
- `test/randomized.test.ts` — 随机交错多进程/复用 pid/多工作负载，与参考实现逐条核对 `m` 与异常值；含伪正常组合用例
- `test/boundary.test.ts` — 跨学习边界存活进程、恰好边界的调用、检测期重复陌生组合不污染基线
