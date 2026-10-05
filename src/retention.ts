import { MinCostFlow } from "./minCostFlow";
import type { RetentionBatchInput, RetentionBatchResult } from "./types";

/**
 * 对一批连续付款申请做整批扣留款分摊。
 *
 * 建模：x[i][t] = lo[i][t] + y[i][t]，lo = floor(金额/10)，
 * y ∈ {0,1} 仅在金额 mod 10 ≠ 0 的分位上自由。y 在 lo 相等的
 * 连续期段（run）内不减少，即每个 run 内 1 构成后缀——等价于
 * 每个 run 至多选择一条“从某期到 run 末尾”的区间。各期 y 的
 * 列和固定为 K[t] = round(合计/10) - Σlo，于是问题化为时间轴上
 * 的区间覆盖最小费用流。费用 = 偏差增量 × 2^M + 字典序权重
 * （BigInt 叠加，保证先全局最优、再按(期,分项)字典序取小）。
 */
export function allocateRetention(input: RetentionBatchInput): RetentionBatchResult {
  const amounts = validate(input);
  const itemCount = amounts.length;
  const periodCount = itemCount === 0 ? 0 : amounts[0]!.length;
  if (itemCount === 0 || periodCount === 0) {
    return {
      cumulative: amounts.map(() => []),
      current: amounts.map(() => []),
    };
  }

  // lo[i][t]、余数 r[i][t]；r=0 的格子 y 恒为 0
  const lo: number[][] = [];
  const remainder: number[][] = [];
  for (let i = 0; i < itemCount; i++) {
    const loRow: number[] = [];
    const rRow: number[] = [];
    for (let t = 0; t < periodCount; t++) {
      const a = amounts[i]![t]!;
      loRow.push(Math.floor(a / 10));
      rRow.push(a % 10);
    }
    lo.push(loRow);
    remainder.push(rRow);
  }

  // 各期项目合计的四舍五入目标（半分向上）与 y 列和 K[t]
  const targetK: number[] = [];
  for (let t = 0; t < periodCount; t++) {
    let sumAmount = 0;
    let sumLo = 0;
    let freeCount = 0;
    for (let i = 0; i < itemCount; i++) {
      sumAmount += amounts[i]![t]!;
      sumLo += lo[i]![t]!;
      if (remainder[i]![t]! > 0) freeCount++;
    }
    const total = Math.floor((sumAmount + 5) / 10);
    const k = total - sumLo;
    if (k < 0 || k > freeCount) {
      throw new Error(`inconsistent input at period ${t + 1}: cannot align column sum`);
    }
    targetK.push(k);
  }

  // 自由格子按 (期, 分项) 顺序编号，决定并列次序权重
  const cellIndex: number[][] = amounts.map((row) => row.map(() => -1));
  let freeTotal = 0;
  for (let t = 0; t < periodCount; t++) {
    for (let i = 0; i < itemCount; i++) {
      if (remainder[i]![t]! > 0) {
        cellIndex[i]![t] = freeTotal;
        freeTotal++;
      }
    }
  }
  const scale = 1n << BigInt(freeTotal);
  const weightOf = (p: number): bigint => 1n << BigInt(freeTotal - 1 - p);

  // 每个分项按 lo 相等的连续期段划分 run，收集自由期位置
  interface Run {
    item: number;
    positions: number[]; // 0 起始期号，升序
  }
  const runs: Run[] = [];
  for (let i = 0; i < itemCount; i++) {
    let t = 0;
    while (t < periodCount) {
      let end = t;
      while (end + 1 < periodCount && lo[i]![end + 1]! === lo[i]![t]!) end++;
      const positions: number[] = [];
      for (let q = t; q <= end; q++) {
        if (remainder[i]![q]! > 0) positions.push(q);
      }
      if (positions.length > 0) runs.push({ item: i, positions });
      t = end + 1;
    }
  }

  // 节点：时间轴 0..periodCount（期 p 起点 = p，终点侧 = periodCount），
  // 之后每个 run 一个节点，最后超级源、超级汇。
  const runBase = periodCount + 1;
  const superSource = runBase + runs.length;
  const superSink = superSource + 1;
  const flow = new MinCostFlow(superSink + 1);

  // 节点供需：D[v] = K[v] - K[v-1]（K 下标越界视为 0）
  let totalSupply = 0;
  for (let v = 0; v <= periodCount; v++) {
    const kHere = v < periodCount ? targetK[v]! : 0;
    const kPrev = v > 0 ? targetK[v - 1]! : 0;
    const d = kHere - kPrev;
    if (d > 0) {
      flow.addEdge(superSource, v, d, 0n);
      totalSupply += d;
    } else if (d < 0) {
      flow.addEdge(v, superSink, -d, 0n);
    }
  }

  // 每个 run：后缀区间弧 期s → run节点（费用 = 后缀偏差×scale + 后缀权重），
  // run节点 → 末期+1（容量 1，保证每个 run 至多一条区间）。
  // handles[r][k] 记录第 k 条后缀弧，求解后读流量还原 y。
  const handles: number[][] = [];
  for (let rIdx = 0; rIdx < runs.length; rIdx++) {
    const run = runs[rIdx]!;
    const runNode = runBase + rIdx;
    const positions = run.positions;
    const m = positions.length;
    const rowHandles: number[] = new Array<number>(m);
    let suffixCost = 0n;
    for (let k = m - 1; k >= 0; k--) {
      const p = positions[k]!;
      const r = remainder[run.item]![p]!;
      suffixCost += BigInt(10 - 2 * r) * scale + weightOf(cellIndex[run.item]![p]!);
      rowHandles[k] = flow.addEdge(p, runNode, 1, suffixCost);
    }
    flow.addEdge(runNode, positions[m - 1]! + 1, 1, 0n);
    handles.push(rowHandles);
  }

  const sent = flow.minCostMaxFlow(superSource, superSink, totalSupply);
  if (sent !== totalSupply) {
    throw new Error("no feasible retention allocation for the given batch");
  }

  // 还原 y：run 内被流量选中的后缀起点之后的自由格 y=1
  const cumulative: number[][] = [];
  for (let i = 0; i < itemCount; i++) {
    cumulative.push([...lo[i]!]);
  }
  for (let rIdx = 0; rIdx < runs.length; rIdx++) {
    const run = runs[rIdx]!;
    const positions = run.positions;
    for (let k = 0; k < positions.length; k++) {
      if (flow.flowOn(handles[rIdx]![k]!) === 1) {
        for (let j = k; j < positions.length; j++) {
          cumulative[run.item]![positions[j]!]! += 1;
        }
        break;
      }
    }
  }

  const current: number[][] = [];
  for (let i = 0; i < itemCount; i++) {
    const row: number[] = [];
    for (let t = 0; t < periodCount; t++) {
      row.push(cumulative[i]![t]! - (t > 0 ? cumulative[i]![t - 1]! : 0));
    }
    current.push(row);
  }
  return { cumulative, current };
  throw new Error("not implemented");
}

function validate(input: RetentionBatchInput): readonly (readonly number[])[] {
  const amounts = input?.amounts;
  if (!Array.isArray(amounts)) {
    throw new TypeError("amounts must be an array of rows");
  }
  if (amounts.length === 0) return amounts;
  const width = Array.isArray(amounts[0]) ? amounts[0]!.length : -1;
  if (width < 0) {
    throw new TypeError("each row of amounts must be an array");
  }
  for (let i = 0; i < amounts.length; i++) {
    const row = amounts[i];
    if (!Array.isArray(row) || row.length !== width) {
      throw new TypeError(`amounts row ${i} must be an array of length ${width}`);
    }
    for (let t = 0; t < row.length; t++) {
      const a = row[t]!;
      if (!Number.isInteger(a) || a < 0) {
        throw new RangeError(`amounts[${i}][${t}] must be a non-negative integer (cents)`);
      }
      if (t > 0 && a < row[t - 1]!) {
        throw new RangeError(`amounts[${i}] must be non-decreasing over periods`);
      }
    }
  }
  return amounts;
}
