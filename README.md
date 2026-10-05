# reward-redemption

员工认可积分兑换实物奖励的结算库（TypeScript，无接口层，供上层应用直接调用）。
状态持久化在 SQLite（Node.js 内置 `node:sqlite`），无任何第三方依赖。

## 要求

- Node.js >= 23.6（内置 TypeScript 类型擦除与 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试

## 用法

```ts
import { RedemptionService } from './src/index.ts';

const service = new RedemptionService({
  dbPath: 'redemption.db', // 省略则使用内存库
  employees: [{ id: 'emp-1', points: 1000 }],
  rewards: [{ id: 'rw-1', price: 100, stock: 10 }],
  hrHandler: async (redemptionId) => {
    // 调用方提供的进程内异步 HR 处理动作：
    // resolve 表示该兑换已交付；reject 仅表示本次尝试未交付。
  },
  // retryDelaysMs: [5000, 10000], // 默认：提交后 5s / 10s 启动第 2、3 次尝试
});

const result = service.submit({ redemptionId: 'r-1', employeeId: 'emp-1', rewardId: 'rw-1' });
const view = service.cancel('r-1');       // 立即返回当前状态
const snapshot = service.snapshot();      // 同一事务内的一致快照
service.close();
```

## 语义

- 接受兑换时在同一事务内扣减积分、库存与季度名额，任一不足则整笔拒绝。
- 同一员工同一奖励每个 UTC 自然季度最多两笔；季度按首次接受时间固定。
- 同一兑换 ID 重复提交/取消幂等，资源只扣减/归还一次。
- 最多三次履约尝试（提交后立即、+5s、+10s），允许重叠；任一成功即完成，
  三次均明确失败才拒绝并归还全部资源。
- 取消立即返回：有未决尝试时保持 `cancelling` 并继续占用资源，
  全部已启动尝试失败后才取消并归还；期间任何成功仍使兑换完成。
