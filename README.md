# task26100760

批发订单缺货自动回填组件 `ReservationEngine`（TypeScript，纯进程内实现，无外部服务依赖）。

## 构建与测试

```bash
npm install
npm test
```

`npm test` 会先用 `tsc` 编译 `src/` 到 `dist/`，再用 Node 内置测试运行器执行 `test/*.test.js`。

## API

```ts
import { ReservationEngine, RESERVATION_TTL_MS } from './dist/ReservationEngine';

const engine = new ReservationEngine({
  W1: { SKU_A: 5, SKU_B: 5 },   // 仓库 -> SKU -> 初始库存
});

engine.apply({ type: 'Submit',  now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'SKU_A', quantity: 2 }] } });
engine.apply({ type: 'Restock', now: 1, warehouseId: 'W1', sku: 'SKU_B', quantity: 3 });
engine.apply({ type: 'Cancel',  now: 2, orderId: 'O1' });
engine.apply({ type: 'Tick',    now: 3 });

engine.inspect({ type: 'Order', orderId: 'O1' });   // OrderView | null
engine.inspect({ type: 'Orders' });                 // OrderView[]（可按 warehouseId 过滤）
engine.inspect({ type: 'Inventory' });              // InventoryView[]（可按 warehouseId 过滤）
```

## 语义

- 每次 `apply` 的顺序：先将截止时间 `<= now` 的预留单全部过期并合并释放，再处理事件，最后统一回填。
- 缺货订单进入 `waiting`，不占用任何库存；库存足够时整单预留，状态变为 `reserved`，
  截止时间为当前 `now + 172800000` 毫秒（48 小时）。
- 回填等价于：反复选择当前可整单满足的、提交序号最小的等待单进行预留，直到没有可满足单。
  不可满足的旧单不阻塞新单；同时可满足时按提交顺序。
- `Cancel` 可取消等待单（直接取消）或已预留单（取消并释放占用）；对终态（已取消/已过期）订单无效果。
- 不变量：每仓库 SKU 的 `available`、`reserved` 均非负，且二者之和等于初始库存加累计补货；
  `apply` 返回后不存在仍可整单满足的等待单。

## 目录

- `src/types.ts` — 事件、查询、视图等类型定义
- `src/ReservationEngine.ts` — 引擎实现
- `test/scenario.test.js` — 确定性场景测试（多 SKU 旧单被跳过、取消与同刻多单过期合并释放、提交顺序、整单占用、截止时刻）
- `test/refEngine.js` + `test/random.test.js` — 独立参考实现与随机小规模事件的逐步差分测试（含不变量校验）
