# matching-engine

单交易对内存撮合库（TypeScript）。订单簿与成交状态全部保存在进程内存中，由上层直接调用；输入订单默认已通过资金与交易规格检查，本模块只负责撮合。价格和数量均以整数最小单位表示。

## 构建与测试

```sh
npm install
npm test        # 编译 src+test 后用 node:test 运行
npm run build   # 仅编译到 dist/
```

## API

```ts
import { MatchingEngine } from "matching-engine";

const engine = new MatchingEngine();

// 提交订单：limit / market / stop_limit
const result = engine.submit({ type: "limit", side: "buy", price: 1000, quantity: 5 });
engine.submit({ type: "market", side: "sell", quantity: 3 });
engine.submit({ type: "stop_limit", side: "buy", price: 1200, stopPrice: 1100, quantity: 5 });
// result = { orderId, trades: Trade[], triggers: TriggerEvent[] }
// 一次提交返回本次直接及连锁产生的全部成交与触发记录

engine.cancel(orderId);        // 撤销未成交余量 / 休眠止损单，返回是否成功
engine.depth(levels?);         // { bids: BookLevel[], asks: BookLevel[] }，bids 降序、asks 升序
engine.orderStatus(orderId);   // OrderView | null（含状态、已成交量、剩余量）
engine.lastTradePrice();       // 最新成交价 | null
```

## 撮合规则

- 普通盘口价格优先、同价按进入盘口先后（FIFO）；买单吃最低卖价，卖单吃最高买价。
- 成交价取被动挂单价，数量取双方剩余量较小值；限价单不以劣于限价的价格成交。
- 限价单余量继续挂单；市价单无对手时余量撤销，不挂单；撤单只影响未成交余量。
- 止损限价单休眠时不进普通盘口、不积累时间优先权；买单在最新成交价 ≥ 触发价、卖单在 ≤ 触发价时激活为普通限价单。尚无成交价时保持休眠；提交时已满足条件则立即激活。撤单与盘口变化不更新成交价。
- 每笔成交都判断触发；触发不可撤回。正在撮合的订单处理完毕后，才按"先触发先处理、同笔成交按提交先后"的顺序处理被触发订单；处理期间新触发的排在队尾。一次提交完成全部连锁触发后才返回。
