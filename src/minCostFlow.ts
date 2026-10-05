/**
 * 稀疏图上的最小费用最大流（BigInt 费用）。
 * 逐路增广：初始 Bellman-Ford 求势差，之后每轮 Dijkstra（约化费用非负）。
 * 图规模与流量按扣留款分摊的实际批量设计（节点数千、流量数千）。
 */

interface Edge {
  to: number;
  rev: number;      // 反向边在邻接表中的下标
  cap: number;      // 剩余容量
  cost: bigint;
}

export class MinCostFlow {
  private readonly graph: Edge[][];
  private readonly handles: { from: number; index: number }[] = [];

  constructor(private readonly nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  /** 返回边句柄，供求解后读取流量。 */
  addEdge(from: number, to: number, capacity: number, cost: bigint): number {
    const fwd: Edge = { to, rev: this.graph[to]!.length, cap: capacity, cost };
    const rev: Edge = { to: from, rev: this.graph[from]!.length, cap: 0, cost: -cost };
    this.graph[from]!.push(fwd);
    this.graph[to]!.push(rev);
    this.handles.push({ from, index: this.graph[from]!.length - 1 });
    return this.handles.length - 1;
  }

  /**
   * 从 source 到 sink 发送至多 maxFlow 单位的最小费用流。
   * 返回实际流量；若返回值等于 maxFlow，则该流量下费用最小。
   */
  minCostMaxFlow(source: number, sink: number, maxFlow: number): number {
    const n = this.nodeCount;
    const potential: bigint[] = new Array<bigint>(n).fill(0n);
    this.bellmanFord(source, potential);

    let flow = 0;
    const dist = new Array<bigint>(n);
    const prevNode = new Array<number>(n);
    const prevEdge = new Array<number>(n);

    while (flow < maxFlow) {
      if (!this.dijkstra(source, sink, potential, dist, prevNode, prevEdge)) {
        break;
      }
      for (let v = 0; v < n; v++) {
        potential[v] = potential[v]! + dist[v]!;
      }
      let add = maxFlow - flow;
      for (let v = sink; v !== source; v = prevNode[v]!) {
        add = Math.min(add, this.graph[prevNode[v]!]![prevEdge[v]!]!.cap);
      }
      for (let v = sink; v !== source; v = prevNode[v]!) {
        const e = this.graph[prevNode[v]!]![prevEdge[v]!]!;
        e.cap -= add;
        this.graph[v]![e.rev]!.cap += add;
      }
      flow += add;
    }
    return flow;
  }

  /** 求解后查询 addEdge 所建边的流量。 */
  flowOn(handle: number): number {
    const h = this.handles[handle]!;
    const e = this.graph[h.from]![h.index]!;
    return this.graph[e.to]![e.rev]!.cap;
  }

  private bellmanFord(source: number, potential: bigint[]): void {
    const n = this.nodeCount;
    const INF: bigint | null = null;
    const dist: (bigint | null)[] = new Array<bigint | null>(n).fill(INF);
    dist[source] = 0n;
    for (let iter = 0; iter < n; iter++) {
      let updated = false;
      for (let v = 0; v < n; v++) {
        const dv = dist[v];
        if (dv == null) continue;
        for (const e of this.graph[v]!) {
          if (e.cap <= 0) continue;
          const nd = dv + e.cost;
          if (dist[e.to] === null || nd < dist[e.to]!) {
            dist[e.to] = nd;
            updated = true;
          }
        }
      }
      if (!updated) break;
    }
    for (let v = 0; v < n; v++) {
      potential[v] = dist[v] === null ? 0n : dist[v]!;
    }
  }

  private dijkstra(
    source: number,
    sink: number,
    potential: bigint[],
    dist: bigint[],
    prevNode: number[],
    prevEdge: number[],
  ): boolean {
    const n = this.nodeCount;
    const INF = -1n; // 哨兵：距离均非负，-1 表示未到达
    dist.fill(INF);
    dist[source] = 0n;
    // 二叉堆：[dist, node]
    const heapDist: bigint[] = [];
    const heapNode: number[] = [];
    const push = (d: bigint, v: number): void => {
      let i = heapDist.length;
      heapDist.push(d);
      heapNode.push(v);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapDist[p]! <= heapDist[i]!) break;
        swap(i, p);
        i = p;
      }
    };
    const swap = (a: number, b: number): void => {
      const td = heapDist[a]!; heapDist[a] = heapDist[b]!; heapDist[b] = td;
      const tn = heapNode[a]!; heapNode[a] = heapNode[b]!; heapNode[b] = tn;
    };
    const pop = (): number => {
      const top = heapNode[0]!;
      const lastD = heapDist.pop()!;
      const lastN = heapNode.pop()!;
      if (heapDist.length > 0) {
        heapDist[0] = lastD;
        heapNode[0] = lastN;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heapDist.length && heapDist[l]! < heapDist[m]!) m = l;
          if (r < heapDist.length && heapDist[r]! < heapDist[m]!) m = r;
          if (m === i) break;
          swap(i, m);
          i = m;
        }
      }
      return top;
    };

    push(0n, source);
    while (heapDist.length > 0) {
      const d = heapDist[0]!;
      const v = pop();
      if (dist[v] !== INF && d > dist[v]!) continue;
      const edges = this.graph[v]!;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i]!;
        if (e.cap <= 0) continue;
        const nd = d + e.cost + potential[v]! - potential[e.to]!;
        if (dist[e.to] === INF || nd < dist[e.to]!) {
          dist[e.to] = nd;
          prevNode[e.to] = v;
          prevEdge[e.to] = i;
          push(nd, e.to);
        }
      }
    }
    return dist[sink] !== INF;
  }
}
