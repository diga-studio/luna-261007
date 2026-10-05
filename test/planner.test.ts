import test from "node:test";
import assert from "node:assert/strict";
import { planPicking } from "../src/index.js";
import type { CandidateOrder } from "../src/index.js";

function sequences(plan: { selectedOrders: readonly CandidateOrder[] }) {
  return plan.selectedOrders.map((o) => o.sequence);
}

test("prefers more small packs over one earlier large pack, lexicographic tie-break", () => {
  // 2 cups and 2 badges in stock. Order 1 needs 2 of each; orders 2, 3, 4
  // need 1 of each. Must pick 2 and 3: not the earlier large order, and
  // among 2-order plans not {2, 4}.
  const stock = { cup: 2, badge: 2 };
  const orders: CandidateOrder[] = [
    { sequence: 1, demands: { cup: 2, badge: 2 } },
    { sequence: 2, demands: { cup: 1, badge: 1 } },
    { sequence: 3, demands: { cup: 1, badge: 1 } },
    { sequence: 4, demands: { cup: 1, badge: 1 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(sequences(plan), [2, 3]);
});

test("variants are not interchangeable across colors", () => {
  const stock = { "tshirt:red": 0, "tshirt:blue": 1 };
  const orders: CandidateOrder[] = [
    { sequence: 1, demands: { "tshirt:red": 1 } },
    { sequence: 2, demands: { "tshirt:blue": 1 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(sequences(plan), [2]);
});

test("maximizes order count, not shipped units or stock consumption", () => {
  const stock = { mug: 4 };
  const orders: CandidateOrder[] = [
    { sequence: 1, demands: { mug: 4 } },
    { sequence: 2, demands: { mug: 2 } },
    { sequence: 3, demands: { mug: 2 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(sequences(plan), [2, 3]);
});

test("lexicographic tie-break is not a sum-of-sequences rule", () => {
  // Feasible 2-order plans: {1, 5} (sum 6), {2, 3} (sum 5), {2, 5} (sum 7).
  // A sum-of-sequences rule would pick {2, 3}; the lexicographic rule must
  // pick {1, 5} because 1 < 2 at the first differing position.
  const stock = { a: 1, b: 1, c: 1 };
  const orders: CandidateOrder[] = [
    { sequence: 1, demands: { a: 1, c: 1 } },
    { sequence: 2, demands: { c: 1 } },
    { sequence: 3, demands: { a: 1, b: 1 } },
    { sequence: 5, demands: { b: 1 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(sequences(plan), [1, 5]);
});

test("whole-order only: an order exceeding stock is never partially picked", () => {
  const stock = { scarf: 1, hat: 5 };
  const orders: CandidateOrder[] = [
    { sequence: 1, demands: { scarf: 2 } },
    { sequence: 2, demands: { scarf: 1, hat: 1 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(sequences(plan), [2]);
});

test("shared scarce variant limits how many packs can be completed", () => {
  const stock = { charm: 1, box: 10 };
  const orders: CandidateOrder[] = [
    { sequence: 1, demands: { charm: 1, box: 1 } },
    { sequence: 2, demands: { charm: 1, box: 1 } },
    { sequence: 3, demands: { box: 1 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(sequences(plan), [1, 3]);
});

test("empty input yields an empty plan", () => {
  assert.deepEqual(sequences(planPicking([], { a: 1 })), []);
  assert.deepEqual(sequences(planPicking([{ sequence: 1, demands: { a: 1 } }], {})), []);
});

test("does not mutate the stock snapshot or the input orders", () => {
  const stock = { cup: 1 };
  const orders: CandidateOrder[] = [
    { sequence: 2, demands: { cup: 1 } },
    { sequence: 1, demands: { cup: 1 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(stock, { cup: 1 });
  assert.deepEqual(sequences(plan), [1]);
  assert.deepEqual(orders.map((o) => o.sequence), [2, 1]);
});

test("result is sorted by ascending sequence regardless of input order", () => {
  const stock = { pen: 3 };
  const orders: CandidateOrder[] = [
    { sequence: 9, demands: { pen: 1 } },
    { sequence: 3, demands: { pen: 1 } },
    { sequence: 6, demands: { pen: 1 } },
  ];
  const plan = planPicking(orders, stock);
  assert.deepEqual(sequences(plan), [3, 6, 9]);
});
