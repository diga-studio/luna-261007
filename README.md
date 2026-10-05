# 限时考核与本地证书签发

TypeScript 实现的限时考核组件：SQLite 考核账本 + 本地 JSON 证书文件，支持崩溃恢复与幂等重试。

## 环境要求

- Node.js >= 22.13（使用内置 `node:sqlite`，无任何原生/外部服务依赖）
- `npm install` 后 `npm test` 即可运行（仅 devDependency：typescript、@types/node）

```bash
npm install
npm test        # 编译 src/ 与 test/ 后运行 node:test
npm run build   # 仅编译到 dist/
```

## API

```ts
import { ExamService } from './src/index.js';

const svc = new ExamService(dataDir);           // <dir>/ledger.sqlite + <dir>/certificates/
svc.begin(learnerId, operationId, now);         // => { attemptId, deadline }
svc.submit(attemptId, operationId, answers, now); // => { passed, timedOut, correctCount, totalCount, certificateId? }
svc.result(attemptId);                          // => 持久化状态 + 证书内容
svc.recover(now);                               // 结算超时考核 + 以账本对账证书文件
svc.close();
```

- `now` 为可信且不倒退的毫秒时间戳，由调用方注入，便于测试。
- 初始化内置一份固定考核（10 题：6 单选 + 4 多选，见 `src/exam.ts`），题目等权；
  单选须选中唯一正确项，多选须与正确集合完全相等；正确题数占比 >= 70% 通过（整数比较，不四舍五入）。

## 规则

- 每名学习者同时仅一次未结束考核；最多开始 3 次，begin 成功即占用次数。
- 考核时长 60 分钟；提交时间严格早于 deadline 才有效，否则按超时失败处理。
- 相邻两次考核间隔 24 小时，自前一次有效提交时间或超时 deadline 起算。
- `begin` 与 `recover` 都会结算已超时的考核。
- 同一方法的 `operationId` 标识同一业务请求：重试（now 可变，其余参数不变）返回原结果，
  不重复占用次数。attempt 的 `operation_id` 与 submission 的 `operation_id` 均有唯一约束。

## 崩溃一致性

- 账本：每次状态变更在单个 SQLite 事务内提交（WAL + synchronous=FULL），事务提交点即一致性边界。
- 证书：临时文件 + fsync + 原子重命名；`submit` 返回“通过”前证书已完整落盘。
- `recover(now)`：
  1. 将 deadline 已到且未提交的考核结算为超时；
  2. 以账本为准对账证书目录——补写缺失证书，删除无主证书、不完整文件、临时文件及与账本不符的文件。
- 一旦答卷被持久接纳，恢复后重试仍返回原成绩与同一 `certificateId`；
  失败/超时考核不会留下证书。

## 故障注入

`FaultInjector` 提供三个崩溃点（见 `src/faults.ts`），到达即抛 `SimulatedCrash` 模拟进程终止：

- `begin:afterPersist`：begin 已持久化生效、响应未返回；
- `submit:afterSubmissionPersisted`：答卷与提交时间已被持久接纳、证书未落盘；
- `submit:afterCertWritten`：证书已落盘、submit 未返回。

测试见 `test/recovery.test.ts`：崩溃后重开同一数据目录、`recover`、重试，验证原结果、
证书稳定性与账本/证书一致性。
