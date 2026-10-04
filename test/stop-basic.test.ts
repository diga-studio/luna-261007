import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchingEngine } from "../src/index.js";

test("无成交价时止损单保持休眠，首笔成交后立即判断触发", () => {
  const e = new MatchingEngine();
  const s = e.submit({ type: "stop_limit", side: "buy", price: 200, stopPrice: 100, quantity: 5 });
  assert.equal(s.triggers.length, 0);
  assert.equal(e.orderStatus(1)?.status, "sleeping");
  assert.deepEqual(e.depth(), { bids: [], asks: [] }); // 休眠单不进普通盘口

  // 挂单不产生成交价，止损单仍休眠
  e.submit({ type: "limit", side: "sell", price: 150, quantity: 5 });
  assert.equal(e.orderStatus(1)?.status, "sleeping");

  // 首笔成交 150 >= 触发价 100，立即激活并按限价 200 撮合；对手盘已空则挂买单
  const r = e.submit({ type: "limit", side: "buy", price: 150, quantity: 5 });
  assert.deepEqual(r.trades.map((t) => [t.price, t.quantity]), [[150, 5]]);
  assert.deepEqual(
    r.triggers.map((t) => [t.orderId, t.stopPrice, t.lastTradePrice]),
    [[1, 100, 150]],
  );
  assert.equal(e.orderStatus(1)?.status, "open");
  assert.deepEqual(e.depth().bids, [{ price: 200, totalQuantity: 5, orderCount: 1 }]);
});

test("提交时已有成交价且满足条件的止损单立即激活", () => {
  const e = new MatchingEngine();
  e.submit({ type: "limit", side: "sell", price: 150, quantity: 5 });
  e.submit({ type: "limit", side: "buy", price: 150, quantity: 5 }); // 成交，last=150
  e.submit({ type: "limit", side: "buy", price: 200, quantity: 3 }); // id3 挂买 200

  // 止损卖单触发价 200，last=150 <=200，提交即激活，按限价 120 与 200 买单成交
  const r = e.submit({ type: "stop_limit", side: "sell", price: 120, stopPrice: 200, quantity: 2 });
  assert.deepEqual(
    r.triggers.map((t) => [t.orderId, t.stopPrice, t.lastTradePrice]),
    [[4, 200, 150]],
  );
  assert.deepEqual(r.trades.map((t) => [t.price, t.quantity, t.makerOrderId]), [[200, 2, 3]]);
  assert.equal(e.orderStatus(4)?.status, "filled");
});

test("休眠止损单可撤销，触发后不可撤已成交部分", () => {
  const e = new MatchingEngine();
  e.submit({ type: "limit", side: "sell", price: 100, quantity: 5 });
  e.submit({ type: "limit", side: "buy", price: 100, quantity: 5 }); // last=100
  e.submit({ type: "stop_limit", side: "sell", price: 90, stopPrice: 50, quantity: 3 }); // id3 休眠
  assert.equal(e.cancel(3), true);
  assert.equal(e.orderStatus(3)?.status, "canceled");
  assert.equal(e.cancel(3), false);
});

test("休眠期间不积累时间优先权：激活后同价排在既有挂单之后", () => {
  const e = new MatchingEngine();
  e.submit({ type: "limit", side: "sell", price: 1000, quantity: 10 });
  e.submit({ type: "limit", side: "buy", price: 1000, quantity: 10 }); // last=1000
  e.submit({ type: "limit", side: "buy", price: 1200, quantity: 5 }); // id3 先挂 1200 买
  e.submit({ type: "stop_limit", side: "buy", price: 1200, stopPrice: 1100, quantity: 5 }); // id4 休眠

  // id5 卖 1：与 id3 的 1200 买单成交（被动价 1200），触发 id4
  const r = e.submit({ type: "limit", side: "sell", price: 1100, quantity: 1 });
  assert.deepEqual(r.trades.map((t) => [t.price, t.quantity, t.makerOrderId]), [[1200, 1, 3]]);
  assert.deepEqual(r.triggers.map((t) => t.orderId), [4]);
  // id4 激活后无对手盘，按限价 1200 挂在 id3 之后
  assert.deepEqual(e.depth().bids, [{ price: 1200, totalQuantity: 9, orderCount: 2 }]);

  // 卖方市价 7：先吃 id3 剩余 4，再吃 id4 的 3 —— 同价按进入盘口先后
  const r2 = e.submit({ type: "market", side: "sell", quantity: 7 });
  assert.deepEqual(
    r2.trades.map((t) => [t.price, t.quantity, t.makerOrderId]),
    [
      [1200, 4, 3],
      [1200, 3, 4],
    ],
  );
  assert.equal(e.orderStatus(3)?.status, "filled");
  assert.equal(e.orderStatus(4)?.remainingQuantity, 2);
});
