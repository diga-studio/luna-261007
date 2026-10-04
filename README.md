# task26100729

单交易对内存撮合库（TypeScript）。订单簿与成交状态保存在进程内存中，由上层直接调用；
输入订单默认已通过资金与交易规格检查，本模块只负责撮合。

## 构建与测试

```bash
npm install
npm test        # 先 tsc 构建到 dist/，再用 node:test 跑全部测试
npm run build   # 仅构建
```

只依赖 Node.js（>= 20.13）与 devDependency 中的 typescript，无其他服务或运行时依赖。

## 能力

- 提交订单 `submitOrder`：限价 / 市价 / 止损限价，买卖双向；返回本次提交的成交与触发记录。
- 撤销订单 `cancelOrder`：只撤未成交余量，已发生的成交不变。
- 查看盘口 `getBook(depth?)` 与订单状态 `getOrder(id)`；`lastTradePrice` 为最新成交价。
- 价格、数量均为整数最小单位。

## 撮合规则

- 价格优先、同价按实际进入盘口先后；买单吃最低卖价，卖单吃最高买价。
- 限价单不得以比自身限价更差的价格成交；成交价取被动挂单价，数量取双方余量较小值。
- 限价余量继续挂单；市价余量撤销不挂单。
- 止损限价单休眠时不进盘口：买单在最新成交价 >= 触发价、卖单在 <= 触发价时激活；
  尚无成交价时保持休眠；提交时已满足条件则立即激活。
- 每笔成交都判断触发；触发不可撤回。正在撮合的订单处理完毕后，才按
  “先触发先处理、同笔成交按最初提交先后”的顺序处理被触发订单；
  处理期间新触发的排在队尾。一次提交完成全部连锁触发后才返回。

## 使用示例

```ts
import { MatchingEngine } from './src';

const eng = new MatchingEngine();
eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 10 });
const res = eng.submitOrder({ id: 'b1', side: 'buy', type: 'limit', price: 105, quantity: 4 });
// res.trades   -> [{ seq: 1, takerOrderId: 'b1', makerOrderId: 's1', price: 100, quantity: 4 }]
// res.triggers -> 本次提交触发的止损单记录
// res.order    -> b1 的最新状态
```
