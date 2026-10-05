const test = require('node:test');
const assert = require('node:assert/strict');
const { ReservationEngine, RESERVATION_TTL_MS } = require('../dist/ReservationEngine');
const { RefEngine } = require('./refEngine');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

const WAREHOUSES = ['w0', 'w1'];
const SKUS = ['s0', 's1', 's2'];

function randomInitialInventory(rand) {
  const inv = {};
  for (const wh of WAREHOUSES) {
    inv[wh] = {};
    for (const sku of SKUS) {
      inv[wh][sku] = Math.floor(rand() * 7);
    }
  }
  return inv;
}

function randomEvents(rand, count) {
  const events = [];
  const orderIds = [];
  let now = 0;
  let nextId = 0;
  for (let i = 0; i < count; i++) {
    // 非递减时间：原地、小步、以及超过 TTL 的大跳
    const jump = pick(rand, [0, 0, 1, 7, 1000, RESERVATION_TTL_MS / 2, RESERVATION_TTL_MS, RESERVATION_TTL_MS * 2]);
    now += Math.floor(jump);
    const kind = pick(rand, ['Submit', 'Submit', 'Submit', 'Restock', 'Cancel', 'Tick']);
    if (kind === 'Submit') {
      const lineCount = 1 + Math.floor(rand() * 2);
      const lines = [];
      for (let j = 0; j < lineCount; j++) {
        lines.push({ sku: pick(rand, SKUS), quantity: 1 + Math.floor(rand() * 4) });
      }
      const orderId = `o${nextId++}`;
      orderIds.push(orderId);
      events.push({ type: 'Submit', now, order: { orderId, warehouseId: pick(rand, WAREHOUSES), lines } });
    } else if (kind === 'Restock') {
      events.push({
        type: 'Restock',
        now,
        warehouseId: pick(rand, WAREHOUSES),
        sku: pick(rand, SKUS),
        quantity: 1 + Math.floor(rand() * 4),
      });
    } else if (kind === 'Cancel') {
      if (orderIds.length === 0) {
        events.push({ type: 'Tick', now });
      } else {
        events.push({ type: 'Cancel', now, orderId: pick(rand, orderIds) });
      }
    } else {
      events.push({ type: 'Tick', now });
    }
  }
  return events;
}

function realSnapshot(engine) {
  const orders = engine.inspect({ type: 'Orders' });
  const inventory = engine.inspect({ type: 'Inventory' });
  return { orders, inventory };
}

function checkInvariants(engine, initialInventory, restocked) {
  const inventory = engine.inspect({ type: 'Inventory' });
  const totals = new Map();
  for (const [wh, skus] of Object.entries(initialInventory)) {
    for (const [sku, qty] of Object.entries(skus)) {
      totals.set(`${wh}/${sku}`, qty);
    }
  }
  for (const { warehouseId, sku, quantity } of restocked) {
    const key = `${warehouseId}/${sku}`;
    totals.set(key, (totals.get(key) || 0) + quantity);
  }
  const invMap = new Map();
  for (const row of inventory) {
    assert.ok(row.available >= 0, `available 非负: ${JSON.stringify(row)}`);
    assert.ok(row.reserved >= 0, `reserved 非负: ${JSON.stringify(row)}`);
    const key = `${row.warehouseId}/${row.sku}`;
    assert.equal(
      row.available + row.reserved,
      totals.get(key) || 0,
      `库存守恒: ${key} available+reserved 应等于 初始+补货`
    );
    invMap.set(key, row.available);
  }
  // apply 返回后不存在仍可整单满足的等待单
  for (const order of engine.inspect({ type: 'Orders' })) {
    if (order.status !== 'waiting') continue;
    const satisfiable = order.lines.every(
      (line) => (invMap.get(`${order.warehouseId}/${line.sku}`) || 0) >= line.quantity
    );
    assert.ok(!satisfiable, `等待单 ${order.orderId} 仍可整单满足`);
  }
}

test('随机事件流与独立参考实现逐步一致', () => {
  const SEEDS = 100;
  const EVENTS_PER_SEED = 120;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed);
    const initialInventory = randomInitialInventory(rand);
    const events = randomEvents(rand, EVENTS_PER_SEED);

    const engine = new ReservationEngine(initialInventory);
    const ref = new RefEngine(initialInventory);
    const restocked = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === 'Restock') {
        restocked.push(event);
      }
      engine.apply(event);
      ref.apply(event);

      const actual = realSnapshot(engine);
      const expected = ref.snapshot();
      try {
        assert.deepEqual(actual, expected);
        checkInvariants(engine, initialInventory, restocked);
      } catch (err) {
        err.message = `seed=${seed} 第${i}个事件 ${JSON.stringify(event)}\n${err.message}`;
        throw err;
      }
    }
  }
});
