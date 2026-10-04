import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchingEngine } from "../src/index.js";
test("限价单按价格优先、同价按进入先后撮合，成交价取被动挂单价", () => {
    const e = new MatchingEngine();
    const a1 = e.submit({ type: "limit", side: "sell", price: 101, quantity: 2 });
    assert.equal(a1.trades.length, 0);
    e.submit({ type: "limit", side: "sell", price: 100, quantity: 3 }); // id2
    e.submit({ type: "limit", side: "sell", price: 100, quantity: 4 }); // id3，同价排在 id2 后
    // 买方限价 101，先吃 100 档：id2 全部、id3 部分；成交价取挂单价 100
    const r = e.submit({ type: "limit", side: "buy", price: 101, quantity: 5 });
    assert.deepEqual(r.trades.map((t) => [t.price, t.quantity, t.makerOrderId, t.takerOrderId]), [
        [100, 3, 2, 4],
        [100, 2, 3, 4],
    ]);
    assert.equal(e.orderStatus(4)?.status, "filled");
    assert.equal(e.orderStatus(3)?.remainingQuantity, 2);
    const d = e.depth();
    assert.deepEqual(d.bids, []);
    assert.deepEqual(d.asks, [
        { price: 100, totalQuantity: 2, orderCount: 1 },
        { price: 101, totalQuantity: 2, orderCount: 1 },
    ]);
});
test("限价单不得以比自身限价更差的价格成交，余量挂单", () => {
    const e = new MatchingEngine();
    e.submit({ type: "limit", side: "sell", price: 100, quantity: 5 });
    const r = e.submit({ type: "limit", side: "buy", price: 99, quantity: 5 });
    assert.equal(r.trades.length, 0);
    assert.deepEqual(e.depth().bids, [{ price: 99, totalQuantity: 5, orderCount: 1 }]);
    assert.equal(e.orderStatus(2)?.status, "open");
});
test("市价单吃净对手盘后余量撤销，不得挂单", () => {
    const e = new MatchingEngine();
    e.submit({ type: "limit", side: "sell", price: 100, quantity: 4 });
    const r = e.submit({ type: "market", side: "buy", quantity: 10 });
    assert.deepEqual(r.trades.map((t) => [t.price, t.quantity]), [[100, 4]]);
    const v = e.orderStatus(2);
    assert.equal(v.status, "canceled");
    assert.equal(v.filledQuantity, 4);
    assert.equal(v.remainingQuantity, 6);
    assert.deepEqual(e.depth().bids, []); // 余量不得挂单
});
test("市价单在空盘口直接撤销余量", () => {
    const e = new MatchingEngine();
    const r = e.submit({ type: "market", side: "sell", quantity: 3 });
    assert.equal(r.trades.length, 0);
    assert.equal(e.orderStatus(1)?.status, "canceled");
    assert.deepEqual(e.depth(), { bids: [], asks: [] });
});
test("撤单只影响未成交余量，已成交部分不变", () => {
    const e = new MatchingEngine();
    e.submit({ type: "limit", side: "sell", price: 100, quantity: 10 }); // id1
    e.submit({ type: "limit", side: "buy", price: 100, quantity: 4 }); // id2，吃掉 4
    assert.equal(e.orderStatus(1)?.remainingQuantity, 6);
    assert.equal(e.cancel(1), true);
    const v = e.orderStatus(1);
    assert.equal(v.status, "canceled");
    assert.equal(v.filledQuantity, 4);
    assert.equal(v.remainingQuantity, 6);
    assert.deepEqual(e.depth().asks, []);
    // 重复撤单、撤已成交单、撤不存在单均失败
    assert.equal(e.cancel(1), false);
    assert.equal(e.cancel(2), false);
    assert.equal(e.cancel(999), false);
});
test("撤单与盘口变化不更新最新成交价", () => {
    const e = new MatchingEngine();
    e.submit({ type: "limit", side: "sell", price: 100, quantity: 5 });
    e.submit({ type: "limit", side: "buy", price: 100, quantity: 5 });
    assert.equal(e.lastTradePrice(), 100);
    e.submit({ type: "limit", side: "sell", price: 110, quantity: 5 });
    e.cancel(3);
    assert.equal(e.lastTradePrice(), 100);
});
test("参数校验", () => {
    const e = new MatchingEngine();
    assert.throws(() => e.submit({ type: "limit", side: "buy", quantity: 1 }), /price/);
    assert.throws(() => e.submit({ type: "stop_limit", side: "buy", price: 100, quantity: 1 }), /stopPrice/);
    assert.throws(() => e.submit({ type: "market", side: "buy", quantity: 0 }), /quantity/);
    assert.throws(() => e.submit({ type: "limit", side: "buy", price: 100, quantity: 1.5 }), /quantity/);
});
//# sourceMappingURL=limit-market.test.js.map