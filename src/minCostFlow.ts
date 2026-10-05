/**
 * 通用最小费用最大流（SSP：Bellman-Ford 初始势函数 + 堆优化 Dijkstra）。
 * 费用使用 bigint，以便把“全局偏差最小 + 并列时字典序”编码进单一目标。
 * 容量与流量使用 number（扣留款场景下为小型整数）。
 */

interface Edge {
  to: number;
  rev: number; // 反向边在 to 的邻接表中的下标
  cap: number; // 剩余容量
  cost: bigint; // 单位费用
}

export class MinCostFlow {
  private readonly graph: Edge[][];
  private readonly forwardEdges: Array<{ from: number; index: number }> = [];

  constructor(private readonly nodeCount: number) {
    this.graph = [];
    for (let i = 0; i < nodeCount; i++) this.graph.push([]);
  }

  /** 添加一条边，返回其序号（供 flowOn 查询正向边流量）。 */
  addEdge(from: number, to: number, capacity: number, cost: bigint): number {
    const fwd: Edge = { to, rev: this.graph[to].length, cap: capacity, cost };
    const rev: Edge = { to: from, rev: this.graph[from].length, cap: 0, cost: -cost };
    this.graph[from].push(fwd);
    this.graph[to].push(rev);
    this.forwardEdges.push({ from, index: this.graph[from].length - 1 });
    return this.forwardEdges.length - 1;
  }

  /** 查询 addEdge 返回序号对应正向边上已推送的流量。 */
  flowOn(edgeIndex: number): number {
    const ref = this.forwardEdges[edgeIndex];
    const fwd = this.graph[ref.from][ref.index];
    return this.graph[fwd.to][fwd.rev].cap; // 反向边剩余容量即正向流量
  }

  /**
   * 求 source -> sink 流量恰为 requiredFlow 的最小费用流，返回总费用。
   * 若无法达到要求流量则抛出异常。
   */
  minCostMaxFlow(source: number, sink: number, requiredFlow: number): bigint {
    const n = this.nodeCount;
    const potential: bigint[] = new Array<bigint>(n).fill(0n);

    // 初始势函数：Bellman-Ford，处理负费用边。
    for (let iter = 0; iter < n - 1; iter++) {
      let updated = false;
      for (let v = 0; v < n; v++) {
        for (const e of this.graph[v]) {
          if (e.cap > 0 && potential[e.to] > potential[v] + e.cost) {
            potential[e.to] = potential[v] + e.cost;
            updated = true;
          }
        }
      }
      if (!updated) break;
    }

    let flow = 0;
    let cost = 0n;
    const dist: bigint[] = new Array<bigint>(n);
    const prevNode: number[] = new Array<number>(n);
    const prevEdge: number[] = new Array<number>(n);
    let maxAbsCost = 0n;
    for (const adj of this.graph) {
      for (const e of adj) {
        const abs = e.cost < 0n ? -e.cost : e.cost;
        if (abs > maxAbsCost) maxAbsCost = abs;
      }
    }
    const INF: bigint = (maxAbsCost + 1n) * BigInt(n + 1);

    while (flow < requiredFlow) {
      // Dijkstra（二元堆，懒删除），键为约化费用。
      dist.fill(INF);
      dist[source] = 0n;
      const heap: Array<[bigint, number]> = [[0n, source]];
      while (heap.length > 0) {
        // 弹出最小元素
        const top = heapPop(heap);
        const d = top[0];
        const v = top[1];
        if (d > dist[v]) continue;
        for (let i = 0; i < this.graph[v].length; i++) {
          const e = this.graph[v][i];
          if (e.cap <= 0) continue;
          const nd = d + e.cost + potential[v] - potential[e.to];
          if (nd < dist[e.to]) {
            dist[e.to] = nd;
            prevNode[e.to] = v;
            prevEdge[e.to] = i;
            heapPush(heap, [nd, e.to]);
          }
        }
      }
      if (dist[sink] === INF) {
        throw new Error("minCostMaxFlow: 无法达到要求的流量（图不可行）");
      }
      for (let v = 0; v < n; v++) {
        if (dist[v] < INF) potential[v] += dist[v];
      }
      // 路径瓶颈
      let add = requiredFlow - flow;
      for (let v = sink; v !== source; v = prevNode[v]) {
        add = Math.min(add, this.graph[prevNode[v]][prevEdge[v]].cap);
      }
      for (let v = sink; v !== source; v = prevNode[v]) {
        const e = this.graph[prevNode[v]][prevEdge[v]];
        e.cap -= add;
        this.graph[v][e.rev].cap += add;
        cost += BigInt(add) * e.cost;
      }
      flow += add;
    }
    return cost;
  }
}

function heapPush(heap: Array<[bigint, number]>, item: [bigint, number]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent][0] <= heap[i][0]) break;
    const tmp = heap[parent];
    heap[parent] = heap[i];
    heap[i] = tmp;
    i = parent;
  }
}

function heapPop(heap: Array<[bigint, number]>): [bigint, number] {
  const top = heap[0];
  const last = heap.pop() as [bigint, number];
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
      if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
      if (smallest === i) break;
      const tmp = heap[smallest];
      heap[smallest] = heap[i];
      heap[i] = tmp;
      i = smallest;
    }
  }
  return top;
}
