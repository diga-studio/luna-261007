# 履约预约名额模块

TypeScript + SQLite 的履约预约名额库，供上层直接调用（无接口层）。数据保存在 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 能力

- **班次录入**：`registerShift(id, capacity, pickupStartMs)`，容量与 UTC 取件起点录入后不变。
- **创建预约**：`createReservation(orderId, shiftId, slots)`，单笔操作；每笔订单仅一份预约，成功即占用名额。
- **取件确认**：`confirmPickup(reservationId)`，取件起点 `<= now <` 起点 + 72h；恰好到达截止即超时。已取件预约永久占用名额，不再超时、不可取消或改约。
- **整批变更**：`applyBatch(ops)`，取消与改约可混合，全部生效或全部不生效；容量按整批生效后的净占用判断（满班次等量互换可成功）。
- **到期清理**：`cleanupExpired()`，把已超时的未取件预约标记为 `expired`。业务口径不依赖清理是否执行：到期预约立即释放名额、不能取件或变更。
- **状态查看**：`getShiftStatus(shiftId)` / `getReservation(id)`。

## 业务规则要点

- 班次占用 = 已确认取件名额 + 未取消且未超时（相对业务时钟）的未取件名额。
- 到期判断基于预约**当前**班次的截止时间：改约后旧班次截止时间不再生效。
- 整批变更中任一预约已取消/已取件/已超时，或目标班次已到截止时间，整批不生效且不影响其他预约。
- 时间来自可注入的 `Clock`（测试用 `ManualClock` 替换），假定不回退。

## 使用

```ts
import { ManualClock, ReservationService, Store } from "fulfillment-reservation";

const store = new Store("data.sqlite"); // 或 ":memory:"
const service = new ReservationService({ store, clock: new ManualClock(Date.now()) });

service.registerShift("shift-1", 100, Date.UTC(2026, 9, 6, 8));
const r = service.createReservation("order-1", "shift-1", 2);
service.confirmPickup(r.id);
service.applyBatch([{ kind: "move", reservationId: r.id, targetShiftId: "shift-2" }]);
console.log(service.getShiftStatus("shift-1"));
```

## 构建与测试

要求 Node.js >= 22.5（`node:sqlite`；22.5–23.3 需 `--experimental-sqlite` 标志，23.4+ 无需标志）。

```sh
npm install
npm test
```

## 结构

- `src/types.ts` — 领域类型
- `src/clock.ts` — 业务时钟（可替换）
- `src/errors.ts` — 错误类型
- `src/store.ts` — SQLite 持久化层
- `src/service.ts` — 业务服务（创建/取件/整批变更/清理/状态）
- `test/` — node:test 自动化测试
