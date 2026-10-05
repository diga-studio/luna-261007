# task26100760
# ReservationEngine

批发订单缺货自动回填组件(TypeScript,进程内状态,调用顺序执行)。

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { ReservationEngine } from './src/reservationEngine';

const engine = new ReservationEngine({ W1: { SKU_A: 10 } });

engine.apply({ type: 'submit', now: 0, orderId: 'O1', warehouse: 'W1', demand: { SKU_A: 3 } });
engine.apply({ type: 'restock', now: 10, warehouse: 'W1', sku: 'SKU_A', quantity: 5 });
engine.apply({ type: 'cancel', now: 20, orderId: 'O1' });
engine.apply({ type: 'tick', now: 30 });

const snapshot = engine.inspect({ warehouse: 'W1' });
```

## 语义

- 订单状态:`waiting` / `reserved` / `cancelled` / `expired`。
- 缺货订单进入等待,不占用任何 SKU;满足时整单预留。
- 预留自当前 `now` 起保留 48 小时(172800000 ms),截止时刻 `<= now` 即过期。
- 每次 `apply` 先统一处理过期并释放占用,再处理事件,最后按提交序号回填。
- 等待单无截止时间;`Cancel` 对终态订单无效果。
