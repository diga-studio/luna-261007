import { computeGap } from "./gap";
import { minCostMaxFlow, type FlowEdgeInput } from "./mincostflow";
import type {
  CandidateEntry,
  Employee,
  Position,
  Reservation,
  SuccessionModel,
  SuccessionPlan,
} from "./types";

interface CandidateEdge {
  readonly positionIndex: number;
  readonly employeeIndex: number;
  readonly entry: CandidateEntry;
  readonly gap: number;
}

interface Counts {
  readonly c0: number;
  readonly c1: number;
  readonly c2: number;
}

/**
 * 计算跨就绪时点一致的全局最优候选预留方案。
 *
 * 最优性：建模为二分图最小费用流（岗位与员工容量均为 1，天然满足
 * “每岗最多一人、每人最多一次、不得改派”）。用充分大的分层权重把
 * (C0, C1, C2) 的字典序编码进费用，第一阶段求解得到计数最优；
 * 第二阶段在保持计数最优的前提下对 gap 阈值做可行性扫描，得到最小化的
 * 最大 gap；第三阶段在该阈值内以 gap 为末位费用项求解，得到最小化的
 * gap 总和。三阶段合起来恰好是题目要求的五级字典序精确最优。
 */
export function planSuccession(model: SuccessionModel): SuccessionPlan {
  const positions = model.positions;
  const employees = model.employees;
  const employeeById = new Map<string, Employee>();
  for (const e of employees) employeeById.set(e.id, e);
  const positionById = new Map<string, Position>();
  for (const p of positions) positionById.set(p.id, p);

  // 同一 (岗位, 员工) 重复出现时保留就绪级别最小（最好）的一条。
  const deduped = new Map<string, CandidateEntry>();
  for (const entry of model.candidates) {
    if (!positionById.has(entry.positionId) || !employeeById.has(entry.employeeId)) continue;
    const key = entry.positionId + " " + entry.employeeId;
    const prev = deduped.get(key);
    if (prev === undefined || entry.readiness < prev.readiness) deduped.set(key, entry);
  }

  const positionIndex = new Map<string, number>();
  positions.forEach((p, i) => positionIndex.set(p.id, i));
  const employeeIndex = new Map<string, number>();
  employees.forEach((e, i) => employeeIndex.set(e.id, i));

  const candidateEdges: CandidateEdge[] = [];
  for (const entry of deduped.values()) {
    const position = positionById.get(entry.positionId) as Position;
    const employee = employeeById.get(entry.employeeId) as Employee;
    candidateEdges.push({
      positionIndex: positionIndex.get(entry.positionId) as number,
      employeeIndex: employeeIndex.get(entry.employeeId) as number,
      entry,
      gap: computeGap(position, employee),
    });
  }

  const empty: SuccessionPlan = {
    reservations: [],
    c0: 0,
    c1: 0,
    c2: 0,
    maxGap: 0,
    totalGap: 0,
  };
  if (positions.length === 0 || candidateEdges.length === 0) return empty;

  const positionCount = positions.length;
  const employeeCount = employees.length;
  const source = 0;
  const sink = 1;
  const positionNode = (i: number) => 2 + i;
  const employeeNode = (i: number) => 2 + positionCount + i;
  const nodeCount = 2 + positionCount + employeeCount;

  // 分层权重：W0 >> W1 >> W2 >> 任何可能的 gap 总和，保证字典序精确。
  const pairBound = BigInt(positionCount);
  const w2 = 10000n * pairBound + 1n;
  const w1 = w2 * (pairBound + 1n);
  const w0 = w1 * (pairBound + 1n);
  const countWeight = (readiness: number): bigint =>
    readiness === 0 ? w0 + w1 + w2 : readiness === 1 ? w1 + w2 : w2;

  const structuralEdges = (): FlowEdgeInput[] => {
    const edges: FlowEdgeInput[] = [];
    for (let i = 0; i < positionCount; i++) {
      edges.push({ from: source, to: positionNode(i), capacity: 1, cost: 0n });
    }
    for (let i = 0; i < employeeCount; i++) {
      edges.push({ from: employeeNode(i), to: sink, capacity: 1, cost: 0n });
    }
    return edges;
  };

  const solve = (edgeFilter: (gap: number) => boolean, withGapCost: boolean): number[] => {
    const edges = structuralEdges();
    const candidateEdgeOffset: number[] = [];
    for (const ce of candidateEdges) {
      if (!edgeFilter(ce.gap)) {
        candidateEdgeOffset.push(-1);
        continue;
      }
      candidateEdgeOffset.push(edges.length);
      edges.push({
        from: positionNode(ce.positionIndex),
        to: employeeNode(ce.employeeIndex),
        capacity: 1,
        cost: (withGapCost ? BigInt(ce.gap) : 0n) - countWeight(ce.entry.readiness),
      });
    }
    const result = minCostMaxFlow(nodeCount, source, sink, edges);
    const chosen: number[] = [];
    candidateEdgeOffset.forEach((offset, i) => {
      if (offset >= 0 && result.edgeFlows[offset] > 0) chosen.push(i);
    });
    return chosen;
  };

  const countOf = (chosen: readonly number[]): Counts => {
    let c0 = 0;
    let c1 = 0;
    for (const i of chosen) {
      const r = candidateEdges[i].entry.readiness;
      if (r === 0) c0++;
      if (r <= 1) c1++;
    }
    return { c0, c1, c2: chosen.length };
  };

  // 第一阶段：最大化 (C0, C1, C2)。
  const best = countOf(solve(() => true, false));
  if (best.c2 === 0) return empty;

  // 第二阶段：在保持计数最优的前提下，扫描最小可行的 gap 阈值。
  const distinctGaps = [...new Set(candidateEdges.map((e) => e.gap))].sort((a, b) => a - b);
  let threshold = distinctGaps[distinctGaps.length - 1];
  for (const t of distinctGaps) {
    const counts = countOf(solve((gap) => gap <= t, false));
    if (counts.c0 === best.c0 && counts.c1 === best.c1 && counts.c2 === best.c2) {
      threshold = t;
      break;
    }
  }

  // 第三阶段：阈值内保持计数最优，最小化 gap 总和。
  const finalChosen = solve((gap) => gap <= threshold, true);

  const reservations: Reservation[] = finalChosen.map((i) => {
    const ce = candidateEdges[i];
    return {
      positionId: ce.entry.positionId,
      employeeId: ce.entry.employeeId,
      readiness: ce.entry.readiness,
      gap: ce.gap,
    };
  });
  let maxGap = 0;
  let totalGap = 0;
  for (const r of reservations) {
    if (r.gap > maxGap) maxGap = r.gap;
    totalGap += r.gap;
  }
  const counts = countOf(finalChosen);
  return { reservations, ...counts, maxGap, totalGap };
}
