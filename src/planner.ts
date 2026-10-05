import type { CandidateOrder, InventorySnapshot, PickPlan } from "./types";

interface IndexedOrder {
  readonly order: CandidateOrder;
  /** [variantIndex, quantity][]，已按变体合并同一订单内的重复行。 */
  readonly demands: readonly (readonly [number, number])[];
}

/**
 * 在固定库存快照下，选出整单入选的订单集合：
 * 1. 首要目标：入选订单数最多；
 * 2. 数量相同：入选提交序号升序名单字典序最小。
 * 不执行真实扣库，库存快照保持不变。
 *
 * 实现：按提交序号升序做“优先入选”的深度优先搜索 + 分支限界。
 * 该枚举顺序下，相同入选数的方案按名单字典序从小到大依次被发现，
 * 因此第一个达到最大入选数的方案即字典序最小方案；
 * 此后只需寻找数量严格更多的方案，上界不超过当前最优即可剪枝。
 */
export function planPicking(
  orders: readonly CandidateOrder[],
  inventory: InventorySnapshot,
): PickPlan {
  const variantIndex = new Map<string, number>();
  const remaining: number[] = [];
  const stockOf = (variantId: string): number => {
    const stock = inventory[variantId];
    return stock === undefined ? 0 : stock;
  };

  const seenSeqs = new Set<number>();
  const indexed: IndexedOrder[] = orders.map((order) => {
    if (!Number.isInteger(order.submissionSeq)) {
      throw new Error(`submissionSeq 必须为整数: ${order.submissionSeq}`);
    }
    if (seenSeqs.has(order.submissionSeq)) {
      throw new Error(`submissionSeq 重复: ${order.submissionSeq}`);
    }
    seenSeqs.add(order.submissionSeq);

    const merged = new Map<number, number>();
    for (const line of order.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new Error(
          `订单 ${order.submissionSeq} 的需求件数必须为正整数: ${line.quantity}`,
        );
      }
      let idx = variantIndex.get(line.variantId);
      if (idx === undefined) {
        idx = remaining.length;
        variantIndex.set(line.variantId, idx);
        remaining.push(stockOf(line.variantId));
      }
      merged.set(idx, (merged.get(idx) ?? 0) + line.quantity);
    }
    return { order, demands: [...merged.entries()] };
  });

  indexed.sort((a, b) => a.order.submissionSeq - b.order.submissionSeq);

  const n = indexed.length;
  let best: CandidateOrder[] = [];
  const current: CandidateOrder[] = [];

  const fits = (demands: readonly (readonly [number, number])[]): boolean =>
    demands.every(([idx, qty]) => remaining[idx] >= qty);

  const apply = (
    demands: readonly (readonly [number, number])[],
    delta: number,
  ): void => {
    for (const [idx, qty] of demands) {
      remaining[idx] -= delta * qty;
    }
  };

  const search = (pos: number): void => {
    // 上界：把剩余订单全部入选能拿到的数量；无法严格更优则剪枝。
    if (current.length + (n - pos) <= best.length) {
      return;
    }
    if (pos === n) {
      best = [...current];
      return;
    }
    const { order, demands } = indexed[pos];
    if (fits(demands)) {
      apply(demands, 1);
      current.push(order);
      search(pos + 1);
      current.pop();
      apply(demands, -1);
    }
    search(pos + 1);
  };

  search(0);

  return { selectedOrders: best };
}
