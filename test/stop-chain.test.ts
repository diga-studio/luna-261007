import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchingEngine } from "../src/index.js";

// 场景 A：同一笔成交同时触发多个不同阈值的止损买单，
// 处理顺序按最初提交先后（id 升序），与触发价高低无关。
test("同一笔成交触发多个不同阈值止损单，按提交先后处理", () => {
  const e = new MatchingEngine();
  e.submit({ type: "limit", side: "sell", price: 1000, quantity: 10 }); // id1
  e.submit({ type: "limit", side: "buy", price: 1000, quantity: 10 }); // id2，成交@1000，last=1000
  e.submit({ type: "stop_limit", side: "buy", price: 1200, stopPrice: 1100, quantity: 5 }); // id3
  e.submit({ type: "stop_limit", side: "buy", price: 1200, stopPrice: 1050, quantity: 5 }); // id4
  e.submit({ type: "stop_limit", side: "buy", price: 1300, stopPrice: 1200, quantity: 5 }); // id5
  e.submit({ type: "limit", side: "sell", price: 1100, quantity: 3 }); // id6
  e.submit({ type: "limit", side: "sell", price: 1150, quantity: 4 }); // id7

  // id8 市价买 7：3@1100、4@1150。
  // 第一笔@1100 同时触发 id3(1100) 与 id4(1050)，按提交先后排队 [id3, id4]；
  // 第二笔@1150 不再触发新单（id5 阈值 1200 > 1150，继续休眠）。
  const r = e.submit({ type: "market", side: "buy", quantity: 7 });
  assert.deepEqual(
    r.trades.map((t) => [t.price, t.quantity, t.makerOrderId, t.takerOrderId]),
    [
      [1100, 3, 6, 8],
      [1150, 4, 7, 8],
    ],
  );
  assert.deepEqual(
    r.triggers.map((t) => [t.orderId, t.stopPrice, t.lastTradePrice]),
    [
      [3, 1100, 1100],
      [4, 1050, 1100],
    ],
  );
  // id3、id4 激活后无对手盘，依次挂在 1200 买单档（id3 在前）
  assert.deepEqual(e.depth().bids, [{ price: 1200, totalQuantity: 10, orderCount: 2 }]);
  assert.equal(e.orderStatus(5)?.status, "sleeping");

  // id9 市价卖 7：先吃 id3 的 5，再吃 id4 的 2，验证同价 FIFO
  const r2 = e.submit({ type: "market", side: "sell", quantity: 7 });
  assert.deepEqual(
    r2.trades.map((t) => [t.price, t.quantity, t.makerOrderId]),
    [
      [1200, 5, 3],
      [1200, 2, 4],
    ],
  );
  assert.equal(e.orderStatus(4)?.remainingQuantity, 3);
});

// 场景 B：连锁触发 + 价格反向越过阈值。
// 手算时序（last 初值 960）：
//   id9 市价卖 6 → 3@980（触发 id3）、3@900（同笔触发 id4、id5，按提交先后）
//   → 处理 id3：无对手，挂买 6@990（价格已被反向抬回 990）
//   → 处理 id4：5@990 与 id3 成交（触发 id6，排在 id5 之后）
//   → 处理 id5：1@990 与 id3 成交，余 3 挂卖@900
//   → 处理 id6：2@900 与 id5 成交
// 关键：id4/id5 在 900 被触发，真正撮合时价格已回到 990（高于其触发价），
// 触发不可撤回，仍按限价单执行。
test("连锁触发：触发后价格反向越过阈值仍执行，新触发排在已触发之后", () => {
  const e = new MatchingEngine();
  e.submit({ type: "limit", side: "sell", price: 960, quantity: 10 }); // id1
  e.submit({ type: "limit", side: "buy", price: 960, quantity: 10 }); // id2，成交@960，last=960
  e.submit({ type: "stop_limit", side: "buy", price: 990, stopPrice: 970, quantity: 6 }); // id3
  e.submit({ type: "stop_limit", side: "sell", price: 850, stopPrice: 920, quantity: 5 }); // id4
  e.submit({ type: "stop_limit", side: "sell", price: 900, stopPrice: 950, quantity: 4 }); // id5
  e.submit({ type: "stop_limit", side: "buy", price: 1000, stopPrice: 985, quantity: 2 }); // id6
  e.submit({ type: "limit", side: "buy", price: 980, quantity: 3 }); // id7
  e.submit({ type: "limit", side: "buy", price: 900, quantity: 3 }); // id8

  const r = e.submit({ type: "market", side: "sell", quantity: 6 }); // id9
  assert.deepEqual(
    r.trades.map((t) => [t.price, t.quantity, t.makerOrderId, t.takerOrderId]),
    [
      [980, 3, 7, 9], // id9 吃 id7，触发 id3
      [900, 3, 8, 9], // id9 吃 id8，同笔触发 id4、id5
      [990, 5, 3, 4], // id4 与已挂出的 id3 成交，触发 id6
      [990, 1, 3, 5], // id5 吃 id3 余量，id3 全部成交
      [900, 2, 5, 6], // id6 与 id5 的余量挂单成交
    ],
  );
  assert.deepEqual(
    r.triggers.map((t) => [t.orderId, t.stopPrice, t.lastTradePrice]),
    [
      [3, 970, 980],
      [4, 920, 900], // 提交先于 id5，虽阈值更低仍先处理
      [5, 950, 900],
      [6, 985, 990], // 处理 id4 期间新触发，排在 id5 之后
    ],
  );

  // 终局：id3/id4/id6/id9 全部成交；id5 余 1 挂卖@900；买盘清空
  assert.equal(e.orderStatus(3)?.status, "filled");
  assert.equal(e.orderStatus(4)?.status, "filled");
  assert.equal(e.orderStatus(6)?.status, "filled");
  assert.equal(e.orderStatus(9)?.status, "filled");
  const v5 = e.orderStatus(5)!;
  assert.equal(v5.status, "open");
  assert.equal(v5.remainingQuantity, 1);
  assert.deepEqual(e.depth(), {
    bids: [],
    asks: [{ price: 900, totalQuantity: 1, orderCount: 1 }],
  });
  assert.equal(e.lastTradePrice(), 900);
});

// 场景 C：一次提交必须完成全部连锁触发后才返回；
// 被触发订单自身产生成交时继续级联触发。
test("多级连锁在单次提交内全部完成", () => {
  const e = new MatchingEngine();
  e.submit({ type: "limit", side: "sell", price: 100, quantity: 10 }); // id1
  e.submit({ type: "limit", side: "buy", price: 100, quantity: 10 }); // id2，last=100
  // 三级止损买单，阈值依次抬高
  e.submit({ type: "stop_limit", side: "buy", price: 250, stopPrice: 150, quantity: 1 }); // id3
  e.submit({ type: "stop_limit", side: "buy", price: 250, stopPrice: 200, quantity: 1 }); // id4
  e.submit({ type: "stop_limit", side: "buy", price: 250, stopPrice: 240, quantity: 1 }); // id5
  // 三个价位各挂 1 卖单
  e.submit({ type: "limit", side: "sell", price: 150, quantity: 1 }); // id6
  e.submit({ type: "limit", side: "sell", price: 200, quantity: 1 }); // id7
  e.submit({ type: "limit", side: "sell", price: 240, quantity: 1 }); // id8

  // id9 限价买 1@150：成交@150 触发 id3；id3 买 1@250 吃 id7@200 触发 id4；
  // id4 买 1@250 吃 id8@240 触发 id5；id5 买 1@250 无对手，挂买@250。
  const r = e.submit({ type: "limit", side: "buy", price: 150, quantity: 1 });
  assert.deepEqual(
    r.trades.map((t) => [t.price, t.quantity, t.makerOrderId, t.takerOrderId]),
    [
      [150, 1, 6, 9],
      [200, 1, 7, 3],
      [240, 1, 8, 4],
    ],
  );
  assert.deepEqual(
    r.triggers.map((t) => [t.orderId, t.stopPrice, t.lastTradePrice]),
    [
      [3, 150, 150],
      [4, 200, 200],
      [5, 240, 240],
    ],
  );
  assert.deepEqual(e.depth().bids, [{ price: 250, totalQuantity: 1, orderCount: 1 }]);
  assert.equal(e.lastTradePrice(), 240);
});
