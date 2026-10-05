# db-access-review

数据库权限复核库（TypeScript + SQLite）。由上层调用，只维护授权有效性，不执行真实数据库操作。

## 能力

- `grantAccess({ user, database, role }, now)` — 授权登记。同一 (user, database, role) 组合最多一个未撤销实例；撤销后可重新授予为独立新实例；挂起状态不能通过再次授予绕过。
- `openReviewCycle(database, now)` — 开启复核周期。纳入该数据库当时全部未撤销实例（含已挂起实例），每个实例生成一个待审条目；范围此后不变，允许多个周期重叠。周期在开启后恰好 14×24 小时截止。
- `submitDecisions(decisions, now)` — 批量提交决定，可跨周期。重复提交已生效的相同决定为幂等成功；任何条目试图改成相反决定则整个批次失败。条目变化与授权变化同事务，全部生效或全部不生效。
- `getGrantStatus(grantId, now)` — 状态读取：`active` / `suspended` / `revoked`。实例仅在未撤销且不存在任何绑定到它的已逾期待审条目时可用；截止瞬间（`now >= deadline`）仍待审的条目立即成为挂起原因，不依赖后台任务。

所有判定使用调用方提供且不回退的 UTC 毫秒时间；时间回退会抛出 `RangeError`。

## 使用

```ts
import { createService } from 'db-access-review';

const svc = createService('./review.db'); // 或 ':memory:'
const grantId = svc.grantAccess({ user: 'alice', database: 'db1', role: 'reader' }, Date.now());
const cycle = svc.openReviewCycle('db1', Date.now());
svc.submitDecisions([{ entryId: cycle.entryIds[0], decision: 'confirm' }], Date.now());
const state = svc.getGrantStatus(grantId, Date.now());
```

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 22.5，使用内置 `node:sqlite`）与 devDependencies 中的 `typescript`、`@types/node`，无原生模块、无外部服务。
