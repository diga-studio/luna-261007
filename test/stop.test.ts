import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MatchingEngine } from '../src/index';

test('无成交价时止损单休眠，不进盘口；可撤销', () => {
  const eng = new MatchingEngine();
  const res = eng.submitOrder({
    id: 'st1', side: 'buy', type: 'stop_limit', stopPrice: 105, price: 110, quantity: 2,
  });
  assert.equal(res.trades.length, 0);
  assert.equal(res.triggers.length, 0);
  assert.equal(res.order.status, 'sleeping');
  assert.ok(eng.getBook().bids.length === 0);
  const canceled = eng.cancelOrder('st1');
  assert.equal(canceled.status, 'canceled');
});

test('提交时已有成交价且满足条件：立即激活并撮合', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 's0', side: 'sell', type: 'limit', price: 100, quantity: 1 });
  eng.submitOrder({ id: 'b0', side: 'buy', type: 'limit', price: 100, quantity: 1 });
  assert.equal(eng.lastTradePrice, 100);
  eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 99, quantity: 3 });
  // 买止损 stopPrice 95 <= 最新价 100，提交即激活，按限价 100 撮合
  const res = eng.submitOrder({
    id: 'st1', side: 'buy', type: 'stop_limit', stopPrice: 95, price: 100, quantity: 3,
  });
  assert.deepEqual(res.triggers, [{ orderId: 'st1', byTradeSeq: null, price: 100 }]);
  assert.deepEqual(
    res.trades.map((t) => [t.makerOrderId, t.price, t.quantity]),
    [['s1', 99, 3]],
  );
  assert.equal(res.order.status, 'filled');
});

test('卖止损在最新价 <= 触发价时激活，休眠单不进盘口', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 's0', side: 'sell', type: 'limit', price: 100, quantity: 1 });
  eng.submitOrder({ id: 'b0', side: 'buy', type: 'limit', price: 100, quantity: 1 });
  // 卖止损 stopPrice 98，最新价 100 不满足，休眠
  const res = eng.submitOrder({
    id: 'st1', side: 'sell', type: 'stop_limit', stopPrice: 98, price: 95, quantity: 2,
  });
  assert.equal(res.order.status, 'sleeping');
  assert.ok(eng.getBook().asks.length === 0);
  // 一笔 97 的成交触发它
  eng.submitOrder({ id: 's2', side: 'sell', type: 'limit', price: 97, quantity: 1 });
  const trig = eng.submitOrder({ id: 'b2', side: 'buy', type: 'limit', price: 97, quantity: 1 });
  assert.deepEqual(trig.triggers, [{ orderId: 'st1', byTradeSeq: 2, price: 97 }]);
  // st1 激活后按限价 95 卖出，但盘口已无买单，余量挂 95 卖单
  assert.equal(eng.getOrder('st1')!.status, 'open');
  assert.deepEqual(eng.getBook().asks, [{ price: 95, totalQuantity: 2, orderCount: 1 }]);
});

test('同一笔成交触发多个不同阈值订单：按最初提交先后处理，与触发价无关', () => {
  const eng = new MatchingEngine();
  // 先建立最新成交价 100
  eng.submitOrder({ id: 'w1', side: 'sell', type: 'limit', price: 100, quantity: 1 });
  eng.submitOrder({ id: 'w2', side: 'buy', type: 'limit', price: 100, quantity: 1 });
  // 三个买止损，提交顺序与触发价高低刻意交错（107、103、105）
  eng.submitOrder({ id: 'st1', side: 'buy', type: 'stop_limit', stopPrice: 107, price: 200, quantity: 1 });
  eng.submitOrder({ id: 'st2', side: 'buy', type: 'stop_limit', stopPrice: 103, price: 200, quantity: 1 });
  eng.submitOrder({ id: 'st3', side: 'buy', type: 'stop_limit', stopPrice: 105, price: 200, quantity: 1 });
  assert.equal(eng.getOrder('st1')!.status, 'sleeping');
  // 深度足够的卖单
  eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 108, quantity: 30 });
  // 一笔 108 的成交同时触发三单
  const res = eng.submitOrder({ id: 't1', side: 'buy', type: 'limit', price: 108, quantity: 1 });
  // 触发记录按提交先后：st1, st2, st3（不是按触发价 103/105/107）
  assert.deepEqual(
    res.triggers.map((t) => [t.orderId, t.byTradeSeq, t.price]),
    [
      ['st1', 2, 108],
      ['st2', 2, 108],
      ['st3', 2, 108],
    ],
  );
  // 成交顺序：t1 先完成，随后 st1、st2、st3 依次以 108 各吃 1
  assert.deepEqual(
    res.trades.map((t) => [t.seq, t.takerOrderId, t.makerOrderId, t.price, t.quantity]),
    [
      [2, 't1', 's1', 108, 1],
      [3, 'st1', 's1', 108, 1],
      [4, 'st2', 's1', 108, 1],
      [5, 'st3', 's1', 108, 1],
    ],
  );
  assert.equal(eng.getOrder('st1')!.status, 'filled');
  assert.equal(eng.getOrder('st2')!.status, 'filled');
  assert.equal(eng.getOrder('st3')!.status, 'filled');
});

test('连锁触发 + 价格反向越过阈值：触发不可撤回，新触发排在已触发之后', () => {
  const eng = new MatchingEngine();
  // 最新成交价 110
  eng.submitOrder({ id: 'w1', side: 'sell', type: 'limit', price: 110, quantity: 1 });
  eng.submitOrder({ id: 'w2', side: 'buy', type: 'limit', price: 110, quantity: 1 });
  // A: 卖止损 stop 108（110 不满足，休眠）；B: 买止损 stop 112；C: 卖止损 stop 105
  eng.submitOrder({ id: 'A', side: 'sell', type: 'stop_limit', stopPrice: 108, price: 90, quantity: 6 });
  eng.submitOrder({ id: 'B', side: 'buy', type: 'stop_limit', stopPrice: 112, price: 130, quantity: 4 });
  eng.submitOrder({ id: 'C', side: 'sell', type: 'stop_limit', stopPrice: 105, price: 100, quantity: 2 });
  // 普通盘口
  eng.submitOrder({ id: 'a1', side: 'sell', type: 'limit', price: 108, quantity: 2 });
  eng.submitOrder({ id: 'a2', side: 'sell', type: 'limit', price: 112, quantity: 2 });
  eng.submitOrder({ id: 'a3', side: 'sell', type: 'limit', price: 125, quantity: 4 });
  eng.submitOrder({ id: 'g1', side: 'buy', type: 'limit', price: 104, quantity: 6 });
  eng.submitOrder({ id: 'g2', side: 'buy', type: 'limit', price: 103, quantity: 10 });

  const res = eng.submitOrder({ id: 't1', side: 'buy', type: 'limit', price: 112, quantity: 4 });
  // 手算（热身成交占 seq 1）：
  // 成交2 t1×a1 @108 x2 -> 触发 A（卖 stop 108）
  // 成交3 t1×a2 @112 x2 -> 触发 B（买 stop 112），队列 [A, B]
  // A 先处理：卖 6 给 g1 @104（成交4）-> 触发 C（卖 stop 105），排在 B 后，队列 [B, C]
  // B 后处理：尽管价格已跌回 104（反向越过 112），触发不可撤回，仍以限价 130 买 a3 @125（成交5）
  // C 最后处理：卖 2 给 g2 @103（成交6）
  assert.deepEqual(
    res.trades.map((t) => [t.seq, t.takerOrderId, t.makerOrderId, t.price, t.quantity]),
    [
      [2, 't1', 'a1', 108, 2],
      [3, 't1', 'a2', 112, 2],
      [4, 'A', 'g1', 104, 6],
      [5, 'B', 'a3', 125, 4],
      [6, 'C', 'g2', 103, 2],
    ],
  );
  assert.deepEqual(
    res.triggers.map((t) => [t.orderId, t.byTradeSeq, t.price]),
    [
      ['A', 2, 108],
      ['B', 3, 112],
      ['C', 4, 104],
    ],
  );
  assert.equal(eng.getOrder('A')!.status, 'filled');
  assert.equal(eng.getOrder('B')!.status, 'filled');
  assert.equal(eng.getOrder('C')!.status, 'filled');
  assert.equal(eng.lastTradePrice, 103);
  // g2 余量 8 留在买三
  assert.deepEqual(eng.getBook().bids, [{ price: 103, totalQuantity: 8, orderCount: 1 }]);
});

test('被触发止损单余量按普通限价挂单，不保留休眠期时间优先权', () => {
  const eng = new MatchingEngine();
  eng.submitOrder({ id: 'w1', side: 'sell', type: 'limit', price: 100, quantity: 1 });
  eng.submitOrder({ id: 'w2', side: 'buy', type: 'limit', price: 100, quantity: 1 });
  // 买止损 stop 105 limit 110 qty 10，休眠
  eng.submitOrder({ id: 'st1', side: 'buy', type: 'stop_limit', stopPrice: 105, price: 110, quantity: 10 });
  // 普通限价买 110 qty 1，先进盘口
  eng.submitOrder({ id: 'b1', side: 'buy', type: 'limit', price: 110, quantity: 1 });
  // 卖 3 @ 106：先与 b1 成交 1 @ 110？否——b1 买价 110 更优，先成交
  const r1 = eng.submitOrder({ id: 's1', side: 'sell', type: 'limit', price: 106, quantity: 3 });
  // s1 余量 2 挂 106。此时最新价 110 已触发 st1（买 stop 105；热身成交占 seq 1）
  assert.deepEqual(r1.triggers, [{ orderId: 'st1', byTradeSeq: 2, price: 110 }]);
  // st1 激活后买 10 limit 110：吃掉 s1 余量 2 @ 106，剩余 8 挂 110 买单
  assert.deepEqual(
    r1.trades.map((t) => [t.seq, t.takerOrderId, t.makerOrderId, t.price, t.quantity]),
    [
      [2, 's1', 'b1', 110, 1],
      [3, 'st1', 's1', 106, 2],
    ],
  );
  assert.deepEqual(eng.getBook().bids, [{ price: 110, totalQuantity: 8, orderCount: 1 }]);
});
