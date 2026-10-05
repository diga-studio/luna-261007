# reward-redemption

员工认可积分兑换实物奖励的结算库（TypeScript + SQLite），供上层应用进程内调用，无接口层。

## 运行要求

- Node.js >= 22.18（使用内建 `node:sqlite` 与原生 TypeScript 类型擦除运行，无运行时依赖）
- `npm install` 仅安装开发依赖（typescript，用于 `npm run typecheck`）；`npm test` 本身零依赖

## 命令

```bash
npm install   # 安装开发依赖
npm test      # 运行全部自动化测试（node:test 直接执行 .ts）
npm run typecheck
```

## 用法

```ts
import { RedemptionService } from "reward-redemption";

// hrAction 由调用方提供：进程内异步 HR 处理动作，
// 按兑换ID保证实际交付至多一次；resolve=已交付，reject=本次尝试未交付。
const service = new RedemptionService("./data.sqlite", hrAction, {
  retryDelaysMs: [5000, 10000], // 第2、3次尝试定时（默认值，可注入便于测试）
});

service.seed(
  [{ id: "emp-1", points: 1000 }],   // 初始员工积分（已结算）
  [{ id: "rw-1", price: 100, stock: 10 }], // 奖励价格与库存
);

// 发起兑换：原子扣减积分+库存+季度名额；同ID幂等
const { redemption, accepted, reason } = service.redeem("emp-1", "rw-1", "redemption-uuid");

// 申请取消：立即返回当前状态；取消的终结是异步的
const { redemption: cancelled } = service.cancel("redemption-uuid");

// 一致快照：积分/库存/季度占额/兑换状态来自同一读事务
const snapshot = service.snapshot();
```

## 语义要点

- **受理**：扣减可用积分、一件库存、一个季度名额，任一不足则整笔拒绝，不留部分扣减。
  同员工同奖励每个 UTC 自然季度最多两笔（未终结与已完成均占名额），季度按首次接受时间固定。
- **履约**：接受后立即第 1 次尝试；5s/10s 仍未定局且未申请取消时启动第 2、3 次；最多三次，允许重叠。
  任意已启动尝试成功即 `COMPLETED`；三次均明确失败才 `REJECTED` 并一次性归还全部资源。
- **取消**：已完成不能退款；否则停止未启动的尝试。仍有已启动尝试未返回时保持 `CANCELLING`
  并继续占用资源，全部失败后才 `CANCELLED` 归还资源；期间任何成功仍使兑换完成。
- **一致性**：所有写操作在同步 SQLite 事务内完成（Node 单线程 + 同步驱动 = 串行临界区），
  快照来自单一读事务，不会出现"已取消仍扣资源"或"已完成却归还资源"的组合。

## 目录

- `src/types.ts` — 公开类型
- `src/db.ts` — SQLite 持久化层（事务、原子扣减/归还、快照）
- `src/service.ts` — 兑换状态机与重试调度
- `test/` — node:test 测试（含并发争抢、迟到回执、跨季度、性能时限）
