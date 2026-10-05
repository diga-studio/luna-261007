# shift-cover-invitations

代班邀约库：由上层排班系统调用，全部业务状态持久化到 SQLite，支持多实例 / 多进程共享同一数据文件。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生依赖或外部服务）
- `npm install && npm test` 即可构建并运行全部测试（devDependencies 仅 `typescript`）

## 使用

```ts
import { ShiftCoverService } from 'shift-cover-invitations';

const service = new ShiftCoverService({
  dbPath: './state.db',
  context: {
    employees: [{ id: 'E1', qualifications: ['Q'] }],
    fixedShifts: [{ employeeId: 'E1', start: 0, end: 240 }],
    openings: [{ id: 'O1', start: 10000, end: 10480, requiredQualifications: ['Q'] }],
  },
});

// 查看候选人（不产生预留）
const candidates = service.getCandidates('O1', now);

// 发起邀约（重新检查资格 / 冲突 / 每周额度 / 空缺占用）
const created = service.createInvitation({
  idempotencyKey: 'req-1',
  openingId: 'O1',
  employeeId: 'E1',
  now,
});

// 接受 / 拒绝 / 取消（均携带幂等键）
service.acceptInvitation({ idempotencyKey: 'req-2', invitationId, now });
service.declineInvitation({ idempotencyKey: 'req-3', invitationId, now });
service.cancelInvitation({ idempotencyKey: 'req-4', invitationId, now });

service.close();
```

- 所有时刻为自 Unix epoch 起的整数分钟（UTC）；区间为半开 `[start, end)`；工作周从周一 00:00 UTC 开始。
- 员工资格、固定排班、空缺由上层在构造时提供，运行期间不变。
- 所有修改操作返回 `Result<T>`：成功 `{ ok: true, value }`，失败 `{ ok: false, reason }`。

## 设计要点

- **时间模型**：周序号 = `floor((minute + 4320) / 10080)`（epoch 是周四，回退到周一）。跨周区间按落在各周的实际分钟分别计入，每周上限 2400 分钟，恰好等于允许。
- **有效邀约**：未到期 `pending`（发出时间 +120 分钟，当前时刻等于截止即过期）与 `accepted`。过期在每次读 / 写时按调用方提供的当前时刻判定，写事务内顺带落库为 `expired`，无需定时清理。
- **占用**：有效邀约占用整个空缺区间；候选查询与发起邀约都会合并固定排班 + 有效邀约做重叠检查与逐周额度检查；每个空缺最多一个有效邀约。
- **幂等**：`idempotency_keys` 表记录 键 -> (业务参数指纹, 首次结果)。同键同参（调用时间不参与比较）直接返回首次结果；同键不同参返回 `idempotency_conflict`；首次结果（含失败）落库，关闭重开后语义保留。
- **并发**：WAL + `busy_timeout`；所有修改在 `BEGIN IMMEDIATE` 写事务内执行（过期清扫 → 幂等检查 → 业务校验 → 落库），多进程下等价于某个串行执行；同键并发提交由主键约束保证只执行一次。

## 测试

`npm test` 覆盖：跨周邀约分别顶满两周额度与仅一周超额、多主管争抢同一员工 / 同一空缺、截止时刻重新指派后旧接受与旧取消到达、多进程并发与同键并发、关闭重开后的幂等重试，以及 200 员工 / 2000 排班 / 2000 空缺 / 10 万历史邀约下候选查询 < 200ms。每个用例结束后按原排班与有效邀约独立重算，断言无超额、无重叠、无空缺重复占用、无旧邀约复活。
