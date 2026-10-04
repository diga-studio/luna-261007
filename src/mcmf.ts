interface Edge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
}

/**
 * Successive shortest augmenting path min-cost flow with Johnson potentials.
 * `minCostNegativeFlow` augments one unit at a time along a cheapest
 * source-sink path and stops as soon as the cheapest path has cost >= 0,
 * yielding the minimum total cost over all possible flow values.
 */
export class MinCostFlow {
  private readonly graph: Edge[][] = [];

  constructor(nodeCount: number) {
    for (let i = 0; i < nodeCount; i++) this.graph.push([]);
  }

  /** Adds a directed edge plus its residual reverse edge. Returns the forward edge. */
  addEdge(from: number, to: number, cap: number, cost: number): Edge {
    const forward: Edge = { to, rev: this.graph[to]!.length, cap, cost };
    const backward: Edge = { to: from, rev: this.graph[from]!.length, cap: 0, cost: -cost };
    this.graph[from]!.push(forward);
    this.graph[to]!.push(backward);
    return forward;
  }

  minCostNegativeFlow(source: number, sink: number): { flow: number; cost: number } {
    const n = this.graph.length;
    const potential = this.bellmanFord(source);
    let flow = 0;
    let cost = 0;
    for (;;) {
      const dist = new Array<number>(n).fill(Infinity);
      const prevNode = new Array<number>(n).fill(-1);
      const prevEdge = new Array<number>(n).fill(-1);
      dist[source] = 0;
      // Binary heap of [distance, node].
      const heap: Array<[number, number]> = [[0, source]];
      while (heap.length > 0) {
        const [d, v] = heapPop(heap);
        if (d > dist[v]!) continue;
        const edges = this.graph[v]!;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i]!;
          if (e.cap <= 0) continue;
          const nd = d + e.cost + potential[v]! - potential[e.to]!;
          if (nd < dist[e.to]!) {
            dist[e.to] = nd;
            prevNode[e.to] = v;
            prevEdge[e.to] = i;
            heapPush(heap, [nd, e.to]);
          }
        }
      }
      if (prevNode[sink] === -1) break;
      const pathCost = potential[sink]! - potential[source]! + dist[sink]!;
      if (pathCost >= 0) break;
      for (let v = 0; v < n; v++) {
        if (dist[v]! < Infinity) potential[v]! += dist[v]!;
      }
      let v = sink;
      while (v !== source) {
        const u = prevNode[v]!;
        const e = this.graph[u]![prevEdge[v]!]!;
        e.cap -= 1;
        this.graph[v]![e.rev]!.cap += 1;
        v = u;
      }
      flow += 1;
      cost += pathCost;
    }
    return { flow, cost };
  }

  private bellmanFord(source: number): number[] {
    const n = this.graph.length;
    const dist = new Array<number>(n).fill(Infinity);
    dist[source] = 0;
    for (let iter = 0; iter < n - 1; iter++) {
      let changed = false;
      for (let v = 0; v < n; v++) {
        if (dist[v]! === Infinity) continue;
        for (const e of this.graph[v]!) {
          if (e.cap > 0 && dist[v]! + e.cost < dist[e.to]!) {
            dist[e.to] = dist[v]! + e.cost;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    for (let v = 0; v < n; v++) {
      if (dist[v]! === Infinity) dist[v] = 0;
    }
    return dist;
  }
}

function heapPush(heap: Array<[number, number]>, item: [number, number]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent]![0] <= heap[i]![0]) break;
    const tmp = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = tmp;
    i = parent;
  }
}

function heapPop(heap: Array<[number, number]>): [number, number] {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && heap[left]![0] < heap[smallest]![0]) smallest = left;
      if (right < heap.length && heap[right]![0] < heap[smallest]![0]) smallest = right;
      if (smallest === i) break;
      const tmp = heap[smallest]!;
      heap[smallest] = heap[i]!;
      heap[i] = tmp;
      i = smallest;
    }
  }
  return top;
}
