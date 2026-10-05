# fulfillment-reservation

履约预约名额模块（TypeScript + SQLite），作为库供上层调用，无接口层。

## 能力

- **班次管理**：`createShift(id, capacity, pickupStartUtc)`，容量与 UTC 取件起点录入后不变。
- **创建预约**：`createReservation(orderId, shiftId, slots)`，单笔操作，成功即占用名额；每笔订单仅一份预约。
- **批量变更**：`applyBatch(changes)`，取消与改约可混合为一批，整批全部生效或全部不生效；容量按整批生效后的净占用判断（两个满班次可整批换位）。
- **取件确认**：`confirmPickup(orderId)`，从班次取件起点到起点 +72h 内可确认；确认后永久占用名额。
- **到期清理**：`sweepExpired()`，标记已超时预约；业务口径不依赖清理是否执行，到期即让出容量。
- **状态查看**：`getShiftStatus(shiftId)` / `getReservation(orderId)`。

## 规则摘要

- 截止时间 = 班次取件起点 + 72h，恰好到达即超时；超时预约不能取件、取消或改约。
- 班次占用 = 已确认取件名额 + 未取消且未超时的未取件名额。
- 改约不改变订单名额，截止时间随新班次；旧班次截止时间不再生效。
- 已确认取件的预约不能取消或改约，永不超时。

## 使用

```ts
import { ReservationService, Clock } from "fulfillment-reservation";

const service = new ReservationService("data.db", { clock: myClock }); // clock 可替换，默认系统时钟
service.createShift("shift-1", 100, Date.UTC(2026, 9, 6, 8));
service.createReservation("order-1", "shift-1", 2);
service.applyBatch([{ kind: "rebook", orderId: "order-1", targetShiftId: "shift-2" }]);
service.confirmPickup("order-1");
```

## 构建与测试

```sh
npm install
npm test
```

依赖：Node.js >= 22.5（使用内置 `node:sqlite`），开发依赖仅 `typescript` 与 `@types/node`。
