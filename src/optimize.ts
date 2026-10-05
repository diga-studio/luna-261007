/**
 * 最优分配：把月份分配给技能，使加权得分最大。
 * 约束：每个月最多分配一次；每项技能所得月数不超过其目标月数。
 *
 * 建模为最小费用流：源 -> 月份(容量1) -> 技能(容量1，费用=-points*weight)
 * -> 汇(容量=目标月数)。不断沿最短路增广，直到最短路费用不再为负，
 * 此时总费用最小即总加权得分最大。
 */

export interface AssignmentMonth {
  /** 月份序号。 */
  monthIndex: number;
  /** 该月可证明的技能下标（对应 requirements 数组下标）。 */
  skillOptions: number[];
  /** 该月贡献点数（1 或 2）。 */
  points: number;
}

export interface AssignmentEdge {
  /** 命中的是输入 months 数组中的下标。 */
  monthPos: number;
  skillIndex: number;
}

interface FlowEdge {
  to: number;
  capacity: number;
  cost: number;
  /** 反向边在邻接表中的下标。 */
  reverse: number;
  /** 仅对“月份 -> 技能”的原始边记录含义，用于回读分配结果。 */
  monthPos: number;
  skillIndex: number;
}

const EPSILON = 1e-9;

/**
 * 求最大权分配。返回被选中的 (月份, 技能) 边。
 * 保证在所有合法分配中取得最大总加权得分。
 */
export function optimalAssignment(
  months: AssignmentMonth[],
  capacities: number[],
  weights: number[],
): AssignmentEdge[] {
  const monthCount = months.length;
  const skillCount = capacities.length;
  const source = 0;
  const monthNode = (i: number): number => 1 + i;
  const skillNode = (j: number): number => 1 + monthCount + j;
  const sink = 1 + monthCount + skillCount;
  const nodeCount = sink + 1;

  const graph: FlowEdge[][] = Array.from({ length: nodeCount }, () => []);
  const addEdge = (
    from: number,
    to: number,
    capacity: number,
    cost: number,
    monthPos = -1,
    skillIndex = -1,
  ): void => {
    const forward: FlowEdge = { to, capacity, cost, reverse: graph[to]!.length, monthPos, skillIndex };
    const backward: FlowEdge = { to: from, capacity: 0, cost: -cost, reverse: graph[from]!.length, monthPos: -1, skillIndex: -1 };
    graph[from]!.push(forward);
    graph[to]!.push(backward);
  };

  for (let i = 0; i < monthCount; i += 1) {
    addEdge(source, monthNode(i), 1, 0);
  }
  for (let i = 0; i < monthCount; i += 1) {
    const month = months[i]!;
    for (const skillIndex of month.skillOptions) {
      addEdge(monthNode(i), skillNode(skillIndex), 1, -(month.points * weights[skillIndex]!), i, skillIndex);
    }
  }
  for (let j = 0; j < skillCount; j += 1) {
    addEdge(skillNode(j), sink, capacities[j]!, 0);
  }

  // 逐轮 Bellman-Ford 最短路增广；图很小（<= 60 个月），性能充足且结果确定。
  for (;;) {
    const dist = new Array<number>(nodeCount).fill(Number.POSITIVE_INFINITY);
    const prevNode = new Array<number>(nodeCount).fill(-1);
    const prevEdge = new Array<number>(nodeCount).fill(-1);
    dist[source] = 0;
    for (let round = 0; round < nodeCount - 1; round += 1) {
      let relaxed = false;
      for (let node = 0; node < nodeCount; node += 1) {
        if (dist[node] === Number.POSITIVE_INFINITY) continue;
        const edges = graph[node]!;
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
          const edge = edges[edgeIndex]!;
          if (edge.capacity <= 0) continue;
          const candidate = dist[node]! + edge.cost;
          if (candidate < dist[edge.to]! - EPSILON) {
            dist[edge.to] = candidate;
            prevNode[edge.to] = node;
            prevEdge[edge.to] = edgeIndex;
            relaxed = true;
          }
        }
      }
      if (!relaxed) break;
    }
    // 最短路费用不再为负：继续增广不会提升总得分，停止。
    if (!(dist[sink]! < -EPSILON)) break;
    let node = sink;
    while (node !== source) {
      const from = prevNode[node]!;
      const edge = graph[from]![prevEdge[node]!]!;
      edge.capacity -= 1;
      graph[edge.to]![edge.reverse]!.capacity += 1;
      node = from;
    }
  }

  const assignment: AssignmentEdge[] = [];
  for (let i = 0; i < monthCount; i += 1) {
    for (const edge of graph[monthNode(i)]!) {
      // 原始“月份 -> 技能”边容量从 1 变为 0 表示该月被分配给该技能。
      if (edge.monthPos >= 0 && edge.capacity === 0) {
        assignment.push({ monthPos: edge.monthPos, skillIndex: edge.skillIndex });
      }
    }
  }
  return assignment;
}
