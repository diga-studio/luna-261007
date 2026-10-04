import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MatchingEngine } from '../src/index';

test('限价单完全成交，成交价取被动方价格', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 10 });
  const res = eng.submitOrder({ id: 'b1', side: 'buy', type: 'limit', price: 105, quantity: 10 });
  assert.deepEqual(
    res.trades.map((t) => [t.seq, t.takerOrderId, t.makerOrderId, t.price, t.quantity]),
    [[1, 'b1', 's1', 100, 10]],
  );
  assert.equal(res.order.status, 'filled');
  assert.equal(eng.lastTradePrice, 100);
  assert.ok(eng.getBook().asks.length === 0 && eng.getBook().bids.length === 0);
});

test('同价按进入盘口先后撮合，余量挂单', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 10 });
  eng.submitOrder({ id: 's2', side: 'sell', type: 'limit', price: 101, quantity: 5 });
  eng.submitOrder({ id: 's3', side: 'sell', type: 'limit', price: 100, quantity: 3 });
  // 盘口：卖 100 -> s1(10) 先于 s3(3)，卖 101 -> s2(5)
  assert.deepEqual(eng.getBook().asks, [
    { price: 100, totalQuantity: 13, orderCount: 2 },
    { price: 101, totalQuantity: 5, orderCount: 1 },
  ]);
  const res = eng.submitOrder({ id: 'b1', side: 'buy', type: 'limit', price: 100, quantity: 20 });
  // 先吃 s1 的 10，再吃 s3 的 3；限价 100 吃不到 101 的 s2，余量 7 挂单
  assert.deepEqual(
    res.trades.map((t) => [t.makerOrderId, t.price, t.quantity]),
    [
      ['s1', 100, 10],
      ['s3', 100, 3],
    ],
  );
  assert.equal(res.order.status, 'open');
  assert.equal(res.order.remainingQuantity, 7);
  assert.deepEqual(eng.getBook().bids, [{ price: 100, totalQuantity: 7, orderCount: 1 }]);
  assert.deepEqual(eng.getBook().asks, [{ price: 101, totalQuantity: 5, orderCount: 1 }]);
});

test('买单优先吃最低卖价，卖单优先吃最高买价', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 'b1', side: 'buy', type: 'limit', price: 99, quantity: 5 });
  eng.submitOrder({ id: 'b2', side: 'buy', type: 'limit', price: 100, quantity: 5 });
  const res = eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 98, quantity: 8 });
  // 先吃最高买价 100 的 b2(5)，再吃 99 的 b1(3)
  assert.deepEqual(
    res.trades.map((t) => [t.makerOrderId, t.price, t.quantity]),
    [
      ['b2', 100, 5],
      ['b1', 99, 3],
    ],
  );
  assert.equal(res.order.status, 'filled');
  assert.deepEqual(eng.getBook().bids, [{ price: 99, totalQuantity: 2, orderCount: 1 }]);
});

test('市价单吃光对手后余量撤销，不挂单', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 4 });
  eng.submitOrder({ id: 's2', side: 'sell', type: 'limit', price: 102, quantity: 6 });
  const res = eng.submitOrder({ id: 'm1', side: 'buy', type: 'market', quantity: 20 });
  assert.deepEqual(
    res.trades.map((t) => [t.makerOrderId, t.price, t.quantity]),
    [
      ['s1', 100, 4],
      ['s2', 102, 6],
    ],
  );
  assert.equal(res.order.status, 'canceled');
  assert.equal(res.order.filledQuantity, 10);
  assert.equal(res.order.remainingQuantity, 10);
  assert.ok(eng.getBook().bids.length === 0);
});

test('市价单在空盘口直接撤销', () => {
  const eng = new MatchingEngine();
  const res = eng.submitOrder({ id: 'm1', side: 'sell', type: 'market', quantity: 5 });
  assert.equal(res.trades.length, 0);
  assert.equal(res.order.status, 'canceled');
});

test('撤单只影响余量，已成交部分保留', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 10 });
  eng.submitOrder({ id: 'b1', side: 'buy', type: 'limit', price: 100, quantity: 4 });
  const before = eng.getOrder('s1')!;
  assert.equal(before.filledQuantity, 4);
  const canceled = eng.cancelOrder('s1');
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.filledQuantity, 4);
  assert.equal(canceled.remainingQuantity, 6);
  assert.ok(eng.getBook().asks.length === 0);
  // 已成交订单撤单不再改变状态
  const filled = eng.cancelOrder('b1');
  assert.equal(filled.status, 'filled');
  assert.equal(filled.filledQuantity, 4);
});

test('盘口快照深度限制与订单查询', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 100, quantity: 1 });
  eng.submitOrder({ id: 's2', side: 'sell', type: 'limit', price: 101, quantity: 2 });
  eng.submitOrder({ id: 's3', side: 'sell', type: 'limit', price: 102, quantity: 3 });
  assert.deepEqual(eng.getBook(2).asks, [
    { price: 100, totalQuantity: 1, orderCount: 1 },
    { price: 101, totalQuantity: 2, orderCount: 1 },
  ]);
  assert.equal(eng.getOrder('nope'), null);
  assert.equal(eng.getOrder('s2')!.status, 'open');
});

test('非法输入与重复 ID 报错', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 'a', side: 'buy', type: 'limit', price: 1, quantity: 1 });
  assert.throws(() =>
    eng.submitOrder({ id: 'a', side: 'buy', type: 'limit', price: 1, quantity: 1 }),
  );
  assert.throws(() =>
    eng.submitOrder({ id: 'b', side: 'buy', type: 'limit', price: 1, quantity: 0 }),
  );
  assert.throws(() =>
    eng.submitOrder({ id: 'c', side: 'buy', type: 'limit', quantity: 1 }),
  );
  assert.throws(() =>
    eng.submitOrder({ id: 'd', side: 'buy', type: 'stop_limit', price: 1, quantity: 1 }),
  );
  assert.throws(() => eng.cancelOrder('ghost'));
});
