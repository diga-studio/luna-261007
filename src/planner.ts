import type { CandidateOrder, PickingPlan, StockSnapshot } from "./types.js";

function canFit(
  order: CandidateOrder,
  remaining: Map<string, number>,
): boolean {
  for (const [variant, quantity] of Object.entries(order.demands)) {
    if ((remaining.get(variant) ?? 0) < quantity) {
      return false;
    }
  }
  return true;
}

function applyDemand(
  order: CandidateOrder,
  remaining: Map<string, number>,
  sign: 1 | -1,
): void {
  for (const [variant, quantity] of Object.entries(order.demands)) {
    remaining.set(variant, (remaining.get(variant) ?? 0) - sign * quantity);
  }
}

/**
 * Plans whole-order picking for a batch of candidate gift-pack orders
 * against a fixed stock snapshot.
 *
 * Primary objective: maximize the number of selected orders.
 * Tie-break: among plans with the same count, choose the one whose
 * ascending list of selected sequence numbers is lexicographically
 * smallest.
 *
 * The stock snapshot is not mutated; no real allocation is performed.
 */
export function planPicking(
  orders: readonly CandidateOrder[],
  stock: StockSnapshot,
): PickingPlan {
  const sorted = [...orders].sort((a, b) => a.sequence - b.sequence);
  const remaining = new Map<string, number>(Object.entries(stock));

  // Depth-first search over orders in ascending sequence order, trying
  // "include" before "exclude". The first plan found at the maximal count
  // is therefore the lexicographically smallest ascending sequence list,
  // so branches that can only tie the best count are pruned outright.
  const best: CandidateOrder[] = [];
  const current: CandidateOrder[] = [];

  function search(index: number): void {
    if (current.length + (sorted.length - index) <= best.length) {
      return;
    }
    if (index === sorted.length) {
      best.length = 0;
      best.push(...current);
      return;
    }
    const order = sorted[index];
    if (canFit(order, remaining)) {
      applyDemand(order, remaining, 1);
      current.push(order);
      search(index + 1);
      current.pop();
      applyDemand(order, remaining, -1);
    }
    search(index + 1);
  }

  search(0);
  return { selectedOrders: best };
}
