/**
 * 最小费用流求解器（ successive shortest paths + SPFA ）。
 * 从零流开始，每次沿最短增广路增广，直到最短增广路费用非负为止，
 * 得到所有流量取值中费用最小的整数流。费用允许为负，容量为整数。
 * 供 planSuccession 做精确全局优化，图规模小，SPFA 足够。
 */
export interface FlowEdgeInput {
  readonly from: number;
  readonly to: number;
  readonly capacity: number;
  readonly cost: bigint;
}

export interface FlowResult {
  readonly cost: bigint;
  /** 每条输入边最终承载的流量。 */
  readonly edgeFlows: readonly number[];
}

interface Arc {
  to: number;
  rev: number;
  cap: number;
  cost: bigint;
  inputIndex: number; // -1 表示反向残余边
}

export function minCostMaxFlow(
  nodeCount: number,
  source: number,
  sink: number,
  edges: readonly FlowEdgeInput[],
): FlowResult {
  const graph: Arc[][] = Array.from({ length: nodeCount }, () => []);
  edges.forEach((e, i) => {
    graph[e.from].push({ to: e.to, rev: graph[e.to].length, cap: e.capacity, cost: e.cost, inputIndex: i });
    graph[e.to].push({ to: e.from, rev: graph[e.from].length - 1, cap: 0, cost: -e.cost, inputIndex: -1 });
  });

  const dist = new Array<bigint>(nodeCount);
  const prevNode = new Array<number>(nodeCount);
  const prevArc = new Array<number>(nodeCount);
  const inQueue = new Array<boolean>(nodeCount);

  for (;;) {
    // SPFA 求 source 到各点最短路。
    dist.fill(0n);
    inQueue.fill(false);
    prevNode.fill(-1);
    const queue: number[] = [source];
    inQueue[source] = true;
    while (queue.length > 0) {
      const u = queue.shift() as number;
      inQueue[u] = false;
      for (let ai = 0; ai < graph[u].length; ai++) {
        const arc = graph[u][ai];
        if (arc.cap <= 0) continue;
        const nd = dist[u] + arc.cost;
        const unvisited = prevNode[arc.to] === -1;
        if (arc.to !== source && (unvisited || nd < dist[arc.to])) {
          dist[arc.to] = nd;
          prevNode[arc.to] = u;
          prevArc[arc.to] = ai;
          if (!inQueue[arc.to]) {
            queue.push(arc.to);
            inQueue[arc.to] = true;
          }
        }
      }
    }
    if (prevNode[sink] === -1) break; // 无增广路
    if (dist[sink] >= 0n) break; // 再增广只会变差，已得全局最小费用流

    // 沿最短路增广瓶颈流量。
    let bottleneck = Number.POSITIVE_INFINITY;
    for (let v = sink; v !== source; v = prevNode[v]) {
      bottleneck = Math.min(bottleneck, graph[prevNode[v]][prevArc[v]].cap);
    }
    for (let v = sink; v !== source; v = prevNode[v]) {
      const arc = graph[prevNode[v]][prevArc[v]];
      arc.cap -= bottleneck;
      graph[v][arc.rev].cap += bottleneck;
    }
  }

  const edgeFlows = new Array<number>(edges.length).fill(0);
  let cost = 0n;
  for (let u = 0; u < nodeCount; u++) {
    for (const arc of graph[u]) {
      if (arc.inputIndex >= 0) {
        const used = edges[arc.inputIndex].capacity - arc.cap;
        edgeFlows[arc.inputIndex] = used;
        cost += BigInt(used) * edges[arc.inputIndex].cost;
      }
    }
  }
  return { cost, edgeFlows };
}
