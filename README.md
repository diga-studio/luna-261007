# 代班邀约库（shift-cover-invites）

由上层排班系统调用的 TypeScript 库，提供候选查询、发起邀约、接受/拒绝、取消四类操作。
所有业务状态持久化于 SQLite，支持多实例、多进程共享同一数据文件。

## 快速开始

```bash
npm install
npm test          # 运行全部自动化测试（node:test，Node 24 直接执行 TS）
npm run typecheck # 严格类型检查
```

仅依赖 Node.js 24+ 内置模块（`node:sqlite`、`node:test`），无运行时第三方依赖；
`typescript` 与 `@types/node` 仅用于开发期类型检查。

## API

```ts
import { InviteService } from './src/index.ts';

const service = new InviteService('data.db');
service.configure({ employees, shifts, gaps }); // 静态数据，仅首次生效

const candidates = service.getCandidates('gap-1', nowMin);   // 不产生预留
const invited = service.invite({ key, gapId, employeeId, nowMin });
const answered = service.respond({ key, invitationId, accept: true, nowMin });
const cancelled = service.cancel({ key, invitationId, nowMin });
service.close();
```

- 所有时刻为 UTC 纪元分钟；工作周从周一 00:00 开始，区间含开始不含结束。
- 每周上限 2400 分钟，恰好等于允许；跨周区间按落在各周的实际分钟分别计入。
- 待答复邀约截止时间为发出时间 +120 分钟，`now == deadline` 即过期；
  过期判定在每次调用时按调用方提供的可信时间计算，无需后台清理。
- 修改操作携带幂等键：同键同业务参数返回首次结果（调用时间不参与比较），
  同键不同参数返回 `idempotency_key_conflict`；同键并发只执行一次；
  关闭重开后幂等语义保留。

## 设计要点

- **串行化**：所有修改在 `BEGIN IMMEDIATE` 事务内完成"读幂等键 → 校验 → 写入"，
  SQLite 保证多进程下等价于某个串行执行，不会出现超额、重叠或一空缺两人。
- **占用模型**：未过期的待答复邀约与已接受邀约占用整个空缺区间；
  拒绝、取消、过期立即释放且不可复活（过期是按时间判定的派生状态，不落库）。
- **性能**：候选查询按 `status` 索引只取有效邀约，10 万条历史终态邀约下
  单次查询约 2ms（限制 200ms）。

## 测试

`npm test` 覆盖：跨周邀约分别顶满两周额度与仅一周超额、多主管争抢同一员工/同一空缺、
截止后重新指派时旧接受与旧取消到达、多进程并发与同键并发、关闭重开后的幂等重试，
以及独立重算的一致性校验（无超额、无重叠、空缺不重复占用、旧邀约不复活）
和 200 员工/2000 排班/2000 空缺/10 万历史邀约下的性能验收。
