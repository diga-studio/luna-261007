import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import {
  ReservationEngine,
  RESERVATION_TTL_MS,
  EngineSnapshot,
} from '../src/reservationEngine';

const TTL = RESERVATION_TTL_MS;

function orderStatus(snap: EngineSnapshot, orderId: string): string {
  const order = snap.orders.find((o) => o.orderId === orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order.status;
}

function orderDeadline(snap: EngineSnapshot, orderId: string): number | null {
  const order = snap.orders.find((o) => o.orderId === orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  return order.deadline;
}

function sku(snap: EngineSnapshot, warehouse: string, skuId: string) {
  const row = snap.inventory.find((i) => i.warehouse === warehouse && i.sku === skuId);
  if (!row) throw new Error(`inventory not found: ${warehouse}/${skuId}`);
  return row;
}

test('缺货等待、新单越过不可满足旧单、同刻多单过期与取消合并回填、按提交顺序竞争', () => {
  const engine = new ReservationEngine({ W: { X: 6, Y: 6, Z: 6 } });

  // t=0..2:三张单占掉大部分库存
  engine.apply({ type: 'submit', now: 0, orderId: 'P1', warehouse: 'W', demand: { X: 4 } });
  engine.apply({ type: 'submit', now: 1, orderId: 'P2', warehouse: 'W', demand: { Y: 4 } });
  engine.apply({ type: 'submit', now: 2, orderId: 'P3', warehouse: 'W', demand: { Z: 3 } });
  let snap = engine.inspect({});
  equal(orderStatus(snap, 'P1'), 'reserved');
  equal(orderDeadline(snap, 'P1'), 0 + TTL);
  equal(orderDeadline(snap, 'P2'), 1 + TTL);
  equal(orderDeadline(snap, 'P3'), 2 + TTL);
  equal(sku(snap, 'W', 'X').available, 2);
  equal(sku(snap, 'W', 'Y').available, 2);
  equal(sku(snap, 'W', 'Z').available, 3);

  // t=3:多 SKU 旧单 P4 因 X 不足进入等待,不得提前占用任何 SKU
  engine.apply({ type: 'submit', now: 3, orderId: 'P4', warehouse: 'W', demand: { X: 3, Y: 3, Z: 4 } });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'P4'), 'waiting');
  equal(orderDeadline(snap, 'P4'), null);
  equal(sku(snap, 'W', 'X').available, 2);
  equal(sku(snap, 'W', 'Y').available, 2);
  equal(sku(snap, 'W', 'Z').available, 3);
  equal(sku(snap, 'W', 'X').reserved, 4);

  // t=4..6:可满足的新单越过 P4
  engine.apply({ type: 'submit', now: 4, orderId: 'P5', warehouse: 'W', demand: { X: 2 } });
  engine.apply({ type: 'submit', now: 5, orderId: 'P6', warehouse: 'W', demand: { Y: 2 } });
  engine.apply({ type: 'submit', now: 6, orderId: 'P7', warehouse: 'W', demand: { Z: 3 } });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'P4'), 'waiting');
  equal(orderStatus(snap, 'P5'), 'reserved');
  equal(orderStatus(snap, 'P6'), 'reserved');
  equal(orderStatus(snap, 'P7'), 'reserved');
  equal(sku(snap, 'W', 'X').available, 0);
  equal(sku(snap, 'W', 'Y').available, 0);
  equal(sku(snap, 'W', 'Z').available, 0);

  // t=7..8:更多等待单
  engine.apply({ type: 'submit', now: 7, orderId: 'P8', warehouse: 'W', demand: { X: 4, Y: 4 } });
  engine.apply({ type: 'submit', now: 8, orderId: 'P9', warehouse: 'W', demand: { Z: 3 } });
  // t=9:补货 X+1,再提交 P10 占掉它(稍后用于同刻取消)
  engine.apply({ type: 'restock', now: 9, warehouse: 'W', sku: 'X', quantity: 1 });
  snap = engine.inspect({});
  equal(sku(snap, 'W', 'X').available, 1);
  engine.apply({ type: 'submit', now: 10, orderId: 'P10', warehouse: 'W', demand: { X: 1 } });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'P10'), 'reserved');
  equal(sku(snap, 'W', 'X').available, 0);

  // t=TTL+6:P1/P2/P3/P5/P6/P7 同刻过期,同时取消 P10。
  // 释放合并后:X=4+2+1=7, Y=4+2=6, Z=3+3=6。
  // 回填按提交序:P4{X3,Y3,Z4} 满足 -> 预留;P8{X4,Y4} Y 不足跳过;P9{Z3} Z 剩 2 跳过。
  engine.apply({ type: 'cancel', now: TTL + 6, orderId: 'P10' });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'P1'), 'expired');
  equal(orderStatus(snap, 'P2'), 'expired');
  equal(orderStatus(snap, 'P3'), 'expired');
  equal(orderStatus(snap, 'P5'), 'expired');
  equal(orderStatus(snap, 'P6'), 'expired');
  equal(orderStatus(snap, 'P7'), 'expired');
  equal(orderStatus(snap, 'P10'), 'cancelled');
  equal(orderStatus(snap, 'P4'), 'reserved');
  equal(orderDeadline(snap, 'P4'), TTL + 6 + TTL);
  equal(orderStatus(snap, 'P8'), 'waiting');
  equal(orderStatus(snap, 'P9'), 'waiting');
  equal(sku(snap, 'W', 'X').available, 4);
  equal(sku(snap, 'W', 'Y').available, 3);
  equal(sku(snap, 'W', 'Z').available, 2);

  // t=TTL+7:补货 Y+1、Z+1,先 P8 后 P9,提交顺序决定竞争结果
  engine.apply({ type: 'restock', now: TTL + 7, warehouse: 'W', sku: 'Y', quantity: 1 });
  engine.apply({ type: 'restock', now: TTL + 7, warehouse: 'W', sku: 'Z', quantity: 1 });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'P8'), 'reserved');
  equal(orderDeadline(snap, 'P8'), TTL + 7 + TTL);
  equal(orderStatus(snap, 'P9'), 'reserved');
  equal(orderDeadline(snap, 'P9'), TTL + 7 + TTL);
  equal(sku(snap, 'W', 'X').available, 0);
  equal(sku(snap, 'W', 'Y').available, 0);
  equal(sku(snap, 'W', 'Z').available, 0);

  // 不变量:每个 SKU 可用+占用 = 初始 + 累计补货
  equal(sku(snap, 'W', 'X').available + sku(snap, 'W', 'X').reserved, 7);
  equal(sku(snap, 'W', 'Y').available + sku(snap, 'W', 'Y').reserved, 7);
  equal(sku(snap, 'W', 'Z').available + sku(snap, 'W', 'Z').reserved, 7);
});

test('截止时刻等于 now 的预留在处理事件前过期', () => {
  const engine = new ReservationEngine({ W: { A: 5 } });
  engine.apply({ type: 'submit', now: 100, orderId: 'O1', warehouse: 'W', demand: { A: 5 } });
  let snap = engine.inspect({});
  equal(orderStatus(snap, 'O1'), 'reserved');
  equal(orderDeadline(snap, 'O1'), 100 + TTL);

  // 截止前 1ms 不过期
  engine.apply({ type: 'tick', now: 100 + TTL - 1 });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'O1'), 'reserved');

  // 恰好截止时刻过期,并回填给等待单
  engine.apply({ type: 'submit', now: 100 + TTL - 1, orderId: 'O2', warehouse: 'W', demand: { A: 5 } });
  engine.apply({ type: 'tick', now: 100 + TTL });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'O1'), 'expired');
  equal(orderStatus(snap, 'O2'), 'reserved');
  equal(orderDeadline(snap, 'O2'), 100 + TTL + TTL);
});

test('Cancel:取消等待单、取消已预留单释放占用、终态单无效果', () => {
  const engine = new ReservationEngine({ W: { A: 3 } });
  engine.apply({ type: 'submit', now: 0, orderId: 'O1', warehouse: 'W', demand: { A: 3 } });
  engine.apply({ type: 'submit', now: 1, orderId: 'O2', warehouse: 'W', demand: { A: 3 } });
  engine.apply({ type: 'submit', now: 2, orderId: 'O3', warehouse: 'W', demand: { A: 1 } });

  // 取消等待单 O2
  engine.apply({ type: 'cancel', now: 3, orderId: 'O2' });
  let snap = engine.inspect({});
  equal(orderStatus(snap, 'O2'), 'cancelled');
  equal(sku(snap, 'W', 'A').available, 0);

  // 取消已预留单 O1,释放的库存在本轮回填给 O3
  engine.apply({ type: 'cancel', now: 4, orderId: 'O1' });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'O1'), 'cancelled');
  equal(orderStatus(snap, 'O3'), 'reserved');
  equal(orderDeadline(snap, 'O3'), 4 + TTL);
  equal(sku(snap, 'W', 'A').available, 2);
  equal(sku(snap, 'W', 'A').reserved, 1);

  // 终态单无效果
  engine.apply({ type: 'cancel', now: 5, orderId: 'O1' });
  engine.apply({ type: 'cancel', now: 5, orderId: 'O2' });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'O1'), 'cancelled');
  equal(orderStatus(snap, 'O2'), 'cancelled');
  equal(sku(snap, 'W', 'A').available, 2);

  // 过期单进入终态后取消无效果
  engine.apply({ type: 'tick', now: 4 + TTL });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'O3'), 'expired');
  engine.apply({ type: 'cancel', now: 4 + TTL, orderId: 'O3' });
  snap = engine.inspect({});
  equal(orderStatus(snap, 'O3'), 'expired');
  equal(sku(snap, 'W', 'A').available, 3);
  equal(sku(snap, 'W', 'A').reserved, 0);
});

test('等待单不会被部分占用:库存只够部分 SKU 时保持等待', () => {
  const engine = new ReservationEngine({ W: { A: 5, B: 1 } });
  engine.apply({ type: 'submit', now: 0, orderId: 'O1', warehouse: 'W', demand: { A: 5, B: 2 } });
  const snap = engine.inspect({});
  equal(orderStatus(snap, 'O1'), 'waiting');
  equal(sku(snap, 'W', 'A').available, 5);
  equal(sku(snap, 'W', 'A').reserved, 0);
  equal(sku(snap, 'W', 'B').available, 1);
  equal(sku(snap, 'W', 'B').reserved, 0);
});

test('inspect 按 orderId 与 warehouse 过滤', () => {
  const engine = new ReservationEngine({ W1: { A: 2 }, W2: { A: 9 } });
  engine.apply({ type: 'submit', now: 0, orderId: 'O1', warehouse: 'W1', demand: { A: 1 } });
  engine.apply({ type: 'submit', now: 1, orderId: 'O2', warehouse: 'W2', demand: { A: 1 } });

  const byOrder = engine.inspect({ orderId: 'O1' });
  deepEqual(byOrder.orders.map((o) => o.orderId), ['O1']);

  const byWarehouse = engine.inspect({ warehouse: 'W2' });
  deepEqual(byWarehouse.orders.map((o) => o.orderId), ['O2']);
  deepEqual(byWarehouse.inventory.map((i) => i.warehouse), ['W2']);

  // 不同仓库库存互不影响
  equal(sku(byWarehouse, 'W2', 'A').available, 8);
});

test('非法输入被拒绝', () => {
  const engine = new ReservationEngine({ W: { A: 1 } });
  engine.apply({ type: 'submit', now: 0, orderId: 'O1', warehouse: 'W', demand: { A: 1 } });
  // 重复订单 ID
  let threw = false;
  try {
    engine.apply({ type: 'submit', now: 1, orderId: 'O1', warehouse: 'W', demand: { A: 1 } });
  } catch {
    threw = true;
  }
  equal(threw, true);
  // 时间回退
  threw = false;
  try {
    engine.apply({ type: 'tick', now: 0 });
  } catch {
    threw = true;
  }
  equal(threw, true);
});
