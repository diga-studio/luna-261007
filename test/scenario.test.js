const test = require('node:test');
const assert = require('node:assert/strict');
const { ReservationEngine, RESERVATION_TTL_MS } = require('../dist/ReservationEngine');

const TTL = RESERVATION_TTL_MS;

function orderStatus(engine, orderId) {
  return engine.inspect({ type: 'Order', orderId });
}

function inventoryMap(engine) {
  const rows = engine.inspect({ type: 'Inventory' });
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.warehouseId}/${row.sku}`, [row.available, row.reserved]);
  }
  return map;
}

test('多SKU旧单被跳过，取消与同刻多单过期合并释放后按提交序回填', () => {
  const engine = new ReservationEngine({ W1: { A: 5, B: 5 } });

  // t=0: O1 整单预留 {A:3,B:3}，截止 TTL
  engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 3 }, { sku: 'B', quantity: 3 }] } });
  assert.equal(orderStatus(engine, 'O1').status, 'reserved');
  assert.equal(orderStatus(engine, 'O1').reservedUntil, TTL);
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [2, 3]);
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [2, 3]);

  // t=10: O2 多SKU旧单 {A:4,B:2}，A 不足 -> 等待，不得占用任何 SKU
  engine.apply({ type: 'Submit', now: 10, order: { orderId: 'O2', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 4 }, { sku: 'B', quantity: 2 }] } });
  assert.equal(orderStatus(engine, 'O2').status, 'waiting');
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [2, 3]);
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [2, 3]);

  // t=20: O3 {A:2} 可满足 -> 新单越过不可满足的旧单；O4 {B:2} 同样预留
  engine.apply({ type: 'Submit', now: 20, order: { orderId: 'O3', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 2 }] } });
  engine.apply({ type: 'Submit', now: 20, order: { orderId: 'O4', warehouseId: 'W1', lines: [{ sku: 'B', quantity: 2 }] } });
  assert.equal(orderStatus(engine, 'O3').status, 'reserved');
  assert.equal(orderStatus(engine, 'O3').reservedUntil, 20 + TTL);
  assert.equal(orderStatus(engine, 'O4').status, 'reserved');
  assert.equal(orderStatus(engine, 'O4').reservedUntil, 20 + TTL);
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [0, 5]);
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [0, 5]);

  // t=30: O5 {A:1,B:1} 无货 -> 等待
  engine.apply({ type: 'Submit', now: 30, order: { orderId: 'O5', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }] } });
  assert.equal(orderStatus(engine, 'O5').status, 'waiting');

  // t=40: 取消已预留的 O1 -> 释放 {A:3,B:3}；O2 仍不可满足，O5 竞争成功
  engine.apply({ type: 'Cancel', now: 40, orderId: 'O1' });
  assert.equal(orderStatus(engine, 'O1').status, 'cancelled');
  assert.equal(orderStatus(engine, 'O2').status, 'waiting');
  assert.equal(orderStatus(engine, 'O5').status, 'reserved');
  assert.equal(orderStatus(engine, 'O5').reservedUntil, 40 + TTL);
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [2, 3]);
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [2, 3]);

  // t=TTL+20: O3、O4 同刻过期，释放合并后 O2 整单可满足
  engine.apply({ type: 'Tick', now: TTL + 20 });
  assert.equal(orderStatus(engine, 'O3').status, 'expired');
  assert.equal(orderStatus(engine, 'O4').status, 'expired');
  assert.equal(orderStatus(engine, 'O2').status, 'reserved');
  assert.equal(orderStatus(engine, 'O2').reservedUntil, TTL + 20 + TTL);
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [0, 5]);
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [2, 3]);

  // t=2*TTL+20: O2 在截止时刻恰好过期（<= now），库存全部回到可用
  engine.apply({ type: 'Tick', now: 2 * TTL + 20 });
  assert.equal(orderStatus(engine, 'O2').status, 'expired');
  assert.equal(orderStatus(engine, 'O5').status, 'expired');
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [5, 0]);
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [5, 0]);
});

test('取消等待单与终态订单无效果', () => {
  const engine = new ReservationEngine({ W1: { A: 1 } });
  engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 2 }] } });
  assert.equal(orderStatus(engine, 'O1').status, 'waiting');
  engine.apply({ type: 'Cancel', now: 1, orderId: 'O1' });
  assert.equal(orderStatus(engine, 'O1').status, 'cancelled');
  // 终态订单再取消无效果
  engine.apply({ type: 'Cancel', now: 2, orderId: 'O1' });
  assert.equal(orderStatus(engine, 'O1').status, 'cancelled');
  // 补货后已取消订单不参与回填
  engine.apply({ type: 'Restock', now: 3, warehouseId: 'W1', sku: 'A', quantity: 5 });
  assert.equal(orderStatus(engine, 'O1').status, 'cancelled');
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [6, 0]);
});

test('Restock 触发回填且等待单不提前占用', () => {
  const engine = new ReservationEngine({ W1: { A: 0, B: 1 } });
  engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }] } });
  assert.equal(orderStatus(engine, 'O1').status, 'waiting');
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [1, 0]);
  engine.apply({ type: 'Restock', now: 5, warehouseId: 'W1', sku: 'A', quantity: 2 });
  assert.equal(orderStatus(engine, 'O1').status, 'reserved');
  assert.equal(orderStatus(engine, 'O1').reservedUntil, 5 + TTL);
  assert.deepEqual(inventoryMap(engine).get('W1/A'), [0, 2]);
  assert.deepEqual(inventoryMap(engine).get('W1/B'), [0, 1]);
});

test('同时可满足时新单不能越过旧单', () => {
  const engine = new ReservationEngine({ W1: { A: 0 } });
  engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 1 }] } });
  engine.apply({ type: 'Submit', now: 1, order: { orderId: 'O2', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 1 }] } });
  engine.apply({ type: 'Restock', now: 2, warehouseId: 'W1', sku: 'A', quantity: 1 });
  assert.equal(orderStatus(engine, 'O1').status, 'reserved');
  assert.equal(orderStatus(engine, 'O2').status, 'waiting');
});

test('输入校验', () => {
  const engine = new ReservationEngine({ W1: { A: 1 } });
  assert.throws(() => engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 0 }] } }));
  assert.throws(() => engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 1.5 }] } }));
  assert.throws(() => engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'WX', lines: [{ sku: 'A', quantity: 1 }] } }));
  engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 1 }] } });
  assert.throws(() => engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 1 }] } }));
  assert.throws(() => engine.apply({ type: 'Cancel', now: 1, orderId: 'NOPE' }));
  assert.throws(() => engine.apply({ type: 'Tick', now: -1 }));
  assert.throws(() => new ReservationEngine({ W1: { A: -1 } }));
});

test('inspect 查询', () => {
  const engine = new ReservationEngine({ W1: { A: 2 }, W2: { B: 1 } });
  engine.apply({ type: 'Submit', now: 0, order: { orderId: 'O1', warehouseId: 'W1', lines: [{ sku: 'A', quantity: 1 }] } });
  engine.apply({ type: 'Submit', now: 1, order: { orderId: 'O2', warehouseId: 'W2', lines: [{ sku: 'B', quantity: 1 }] } });
  assert.equal(engine.inspect({ type: 'Order', orderId: 'NOPE' }), null);
  const all = engine.inspect({ type: 'Orders' });
  assert.deepEqual(all.map((o) => o.orderId), ['O1', 'O2']);
  const w1 = engine.inspect({ type: 'Orders', warehouseId: 'W1' });
  assert.deepEqual(w1.map((o) => o.orderId), ['O1']);
  const inv = engine.inspect({ type: 'Inventory', warehouseId: 'W2' });
  assert.deepEqual(inv, [{ warehouseId: 'W2', sku: 'B', available: 0, reserved: 1 }]);
});
