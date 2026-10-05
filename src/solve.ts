import { MinCostFlow } from "./minCostFlow";
import type {
  ItemRetainage,
  RetainageBatchInput,
  RetainageBatchResult,
} from "./types";

/**
 * 建模思路（费用以 1/10 分为单位，全部用整数）：
 * - 每个分项每期累计扣留款 r = floor(a/10) + x，x ∈ {0,1}；
 *   精确金额为整数分时 x 恒为 0（无选择）。
 * - 同一期 Σr 必须等于该期合计金额的 10% 四舍五入（半分向上），
 *   即每期“向上取整”的 x 个数 k_t 被唯一确定。
 * - 同一分项 r 不得随期次减少：在同一 floor 值不变的连续区段内 x 单调不减；
 *   floor 跨档时约束自动成立。
 * - 目标：最小化 Σ|r*10 - a|（十分之几分），并列时按期次、分项顺序
 *   取累计扣留款较小者 —— 通过把字典序编码进 bigint 费用的低位实现。
 *
 * 上述问题等价于时间轴上的最小费用循环流：
 * 前向边承载各期必需的向上取整个数 k_t（上下界相等），
 * 每个“floor 不变的自由选择区段”是一条反向链，流经区段边缘 (t+1)->t
 * 表示该分项第 t 期选择向上取整，费用为偏差增量与字典序位的组合。
 */

interface Segment {
  item: number;
  start: number; // 首期（含），0 基
  end: number; // 末期（含），0 基
  /** 区段边缘边（对应各期 x）在 MinCostFlow 中的序号，按 start..end 排列。 */
  edgeIds: number[];
}

export function solveRetainageBatch(
  input: RetainageBatchInput,
): RetainageBatchResult {
  const amounts = validateInput(input);
  const periodCount = amounts.length;
  if (periodCount === 0) return { periods: [] };
  const itemCount = amounts[0].length;

  // lo[i][t] = floor(a/10)；rem[i][t] = a mod 10；free = rem !== 0
  const lo: number[][] = [];
  const rem: number[][] = [];
  for (let i = 0; i < itemCount; i++) {
    lo.push([]);
    rem.push([]);
    for (let t = 0; t < periodCount; t++) {
      lo[i].push(Math.floor(amounts[t][i] / 10));
      rem[i].push(amounts[t][i] % 10);
    }
  }

  // 每期必须向上取整的个数 k_t
  const ceilCount: number[] = [];
  for (let t = 0; t < periodCount; t++) {
    let total = 0;
    let loSum = 0;
    for (let i = 0; i < itemCount; i++) {
      total += amounts[t][i];
      loSum += lo[i][t];
    }
    const rounded = Math.floor(total / 10) + (total % 10 >= 5 ? 1 : 0);
    ceilCount.push(rounded - loSum);
  }

  // 构造区段：同一 floor 值的连续区间内，最后一个“整十分”位置之后的
  // 自由位置构成一个区段（整十分位置会迫使同区间之前的位置 x=0）。
  const segments: Segment[] = [];
  for (let i = 0; i < itemCount; i++) {
    let runStart = 0;
    for (let t = 1; t <= periodCount; t++) {
      if (t === periodCount || lo[i][t] !== lo[i][runStart]) {
        // 区间 [runStart, t-1] 内 floor 相同
        let lastForced = runStart - 1;
        for (let u = runStart; u < t; u++) {
          if (rem[i][u] === 0) lastForced = u;
        }
        if (lastForced + 1 <= t - 1) {
          segments.push({
            item: i,
            start: lastForced + 1,
            end: t - 1,
            edgeIds: [],
          });
        }
        runStart = t;
      }
    }
  }

  // 字典序位：期次从早到晚、分项按输入顺序，越早的位置权重越高。
  const positionCount = itemCount * periodCount;
  const primaryShift = 1n << BigInt(positionCount);
  const combinedCost = (item: number, t: number): bigint => {
    const primary = BigInt(10 - 2 * rem[item][t]); // 向上取整相对向下取整的偏差增量
    const position = t * itemCount + item;
    const lexBit = 1n << BigInt(positionCount - 1 - position);
    return primary * primaryShift + lexBit;
  };

  // 节点编号：0..periodCount 为共享时间轴，其后为各区段私有节点，最后 SS/TT。
  let nextNode = periodCount + 1;
  const segmentBase: number[] = [];
  for (const seg of segments) {
    segmentBase.push(nextNode);
    nextNode += seg.end - seg.start + 2;
  }
  const superSource = nextNode++;
  const superSink = nextNode++;

  const mcf = new MinCostFlow(nextNode);

  // 共享时间轴前向边的下界产生的节点收支：bal[v] = k_{v-1} - k_v
  const balance: number[] = new Array<number>(periodCount + 1).fill(0);
  for (let t = 0; t < periodCount; t++) {
    balance[t] -= ceilCount[t];
    balance[t + 1] += ceilCount[t];
  }

  // 区段反向链：shared_{e+1} -> p_{e+1} -> p_e -> ... -> p_s，p_t -> shared_t 出口
  segments.forEach((seg, idx) => {
    const base = segmentBase[idx];
    const nodeOf = (t: number): number => base + (t - seg.start);
    mcf.addEdge(seg.end + 1, nodeOf(seg.end + 1), 1, 0n); // 入口
    for (let t = seg.end; t >= seg.start; t--) {
      const edgeId = mcf.addEdge(
        nodeOf(t + 1),
        nodeOf(t),
        1,
        combinedCost(seg.item, t),
      );
      seg.edgeIds[t - seg.start] = edgeId;
    }
    for (let t = seg.start; t <= seg.end; t++) {
      mcf.addEdge(nodeOf(t), t, 1, 0n); // 出口
    }
  });

  // 超级源汇：把下界收支转成固定总量的最小费用流
  let requiredFlow = 0;
  for (let v = 0; v <= periodCount; v++) {
    if (balance[v] > 0) {
      mcf.addEdge(superSource, v, balance[v], 0n);
      requiredFlow += balance[v];
    } else if (balance[v] < 0) {
      mcf.addEdge(v, superSink, -balance[v], 0n);
    }
  }

  mcf.minCostMaxFlow(superSource, superSink, requiredFlow);

  // 取回每个分项每期的 x（是否向上取整）
  const rounded: boolean[][] = [];
  for (let i = 0; i < itemCount; i++) {
    rounded.push(new Array<boolean>(periodCount).fill(false));
  }
  for (const seg of segments) {
    for (let t = seg.start; t <= seg.end; t++) {
      if (mcf.flowOn(seg.edgeIds[t - seg.start]) === 1) {
        rounded[seg.item][t] = true;
      }
    }
  }

  // 汇总结果并做内部一致性校验
  const cumulative: number[][] = [];
  for (let i = 0; i < itemCount; i++) {
    cumulative.push([]);
    for (let t = 0; t < periodCount; t++) {
      cumulative[i].push(lo[i][t] + (rounded[i][t] ? 1 : 0));
    }
  }
  verifySolution(amounts, cumulative);

  const periodResults = [];
  for (let t = 0; t < periodCount; t++) {
    const items: ItemRetainage[] = [];
    for (let i = 0; i < itemCount; i++) {
      const previous = t > 0 ? cumulative[i][t - 1] : 0;
      items.push({
        cumulativeCents: cumulative[i][t],
        currentCents: cumulative[i][t] - previous,
      });
    }
    periodResults.push({ items });
  }
  return { periods: periodResults };
}

function validateInput(input: RetainageBatchInput): number[][] {
  if (input === null || typeof input !== "object" || !Array.isArray(input.periodsCents)) {
    throw new TypeError("输入必须包含 periodsCents 数组");
  }
  const amounts: number[][] = [];
  let itemCount = -1;
  for (let t = 0; t < input.periodsCents.length; t++) {
    const row = input.periodsCents[t];
    if (!Array.isArray(row)) throw new TypeError(`第 ${t + 1} 期不是数组`);
    if (itemCount === -1) itemCount = row.length;
    if (row.length !== itemCount) {
      throw new RangeError(`第 ${t + 1} 期分项数量与首期不一致`);
    }
    const normalized: number[] = [];
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`第 ${t + 1} 期第 ${i + 1} 项金额必须是非负整数分`);
      }
      if (t > 0 && value < amounts[t - 1][i]) {
        throw new RangeError(`第 ${i + 1} 项累计金额在第 ${t + 1} 期出现减少`);
      }
      normalized.push(value);
    }
    amounts.push(normalized);
  }
  return amounts;
}

/** 内部不变量校验：任何违反都说明求解器存在缺陷。 */
function verifySolution(amounts: number[][], cumulative: number[][]): void {
  const periodCount = amounts.length;
  const itemCount = periodCount === 0 ? 0 : amounts[0].length;
  for (let t = 0; t < periodCount; t++) {
    let total = 0;
    let sum = 0;
    for (let i = 0; i < itemCount; i++) {
      const a = amounts[t][i];
      const r = cumulative[i][t];
      const lo = Math.floor(a / 10);
      if (r !== lo && r !== lo + 1) {
        throw new Error(`内部校验失败：第 ${t + 1} 期第 ${i + 1} 项扣留款越界`);
      }
      if (a % 10 === 0 && r !== lo) {
        throw new Error(`内部校验失败：第 ${t + 1} 期第 ${i + 1} 项精确值被改动`);
      }
      if (t > 0 && r < cumulative[i][t - 1]) {
        throw new Error(`内部校验失败：第 ${i + 1} 项累计扣留款倒退`);
      }
      total += a;
      sum += r;
    }
    const expected = Math.floor(total / 10) + (total % 10 >= 5 ? 1 : 0);
    if (sum !== expected) {
      throw new Error(`内部校验失败：第 ${t + 1} 期扣留款合计 ${sum} != ${expected}`);
    }
  }
}
