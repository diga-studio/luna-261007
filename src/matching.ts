/**
 * Max-weight bipartite b-matching between months and skills, solved
 * exactly by min-cost max-flow (SPFA shortest augmenting paths).
 * Each month is used at most once; each skill j at most capacities[j]
 * times; values[i][j] > 0 means month i may serve skill j for that
 * value, 0 means no edge. Returns assignment[i] = j or -1,
 * maximizing total value.
 */
export function maxWeightAssignment(
  values: number[][],
  capacities: number[],
): number[] {
  const monthCount = values.length;
  const skillCount = capacities.length;
  const source = 0;
  const monthNode = (i: number) => 1 + i;
  const skillNode = (j: number) => 1 + monthCount + j;
  const sink = 1 + monthCount + skillCount;
  const nodeCount = sink + 1;

  interface Edge {
    to: number;
    rev: number;
    cap: number;
    cost: number;
  }
  const graph: Edge[][] = Array.from({ length: nodeCount }, () => []);
  const addEdge = (from: number, to: number, cap: number, cost: number) => {
    graph[from].push({ to, rev: graph[to].length, cap, cost });
    graph[to].push({ to: from, rev: graph[from].length - 1, cap: 0, cost: -cost });
  };

  for (let i = 0; i < monthCount; i++) {
    addEdge(source, monthNode(i), 1, 0);
  }
  const monthSkillEdge: number[][] = values.map((row, i) =>
    row.map((value, j) => {
      if (value <= 0) return -1;
      addEdge(monthNode(i), skillNode(j), 1, -value);
      return graph[monthNode(i)].length - 1;
    }),
  );
  for (let j = 0; j < skillCount; j++) {
    if (capacities[j] > 0) {
      addEdge(skillNode(j), sink, capacities[j], 0);
    }
  }

  // Successive shortest augmenting paths; every augmentation carries
  // one unit, so at most monthCount iterations.
  for (;;) {
    const dist = new Array<number>(nodeCount).fill(Infinity);
    const prevNode = new Array<number>(nodeCount).fill(-1);
    const prevEdge = new Array<number>(nodeCount).fill(-1);
    const inQueue = new Array<boolean>(nodeCount).fill(false);
    dist[source] = 0;
    const queue: number[] = [source];
    inQueue[source] = true;
    while (queue.length > 0) {
      const node = queue.shift()!;
      inQueue[node] = false;
      for (let e = 0; e < graph[node].length; e++) {
        const edge = graph[node][e];
        if (edge.cap <= 0) continue;
        const next = dist[node] + edge.cost;
        if (next < dist[edge.to] - 1e-12) {
          dist[edge.to] = next;
          prevNode[edge.to] = node;
          prevEdge[edge.to] = e;
          if (!inQueue[edge.to]) {
            queue.push(edge.to);
            inQueue[edge.to] = true;
          }
        }
      }
    }
    if (prevNode[sink] === -1) break;
    let flow = Infinity;
    for (let v = sink; v !== source; v = prevNode[v]) {
      flow = Math.min(flow, graph[prevNode[v]][prevEdge[v]].cap);
    }
    for (let v = sink; v !== source; v = prevNode[v]) {
      const edge = graph[prevNode[v]][prevEdge[v]];
      edge.cap -= flow;
      graph[v][edge.rev].cap += flow;
    }
  }

  return values.map((row, i) => {
    for (let j = 0; j < row.length; j++) {
      const edgeIndex = monthSkillEdge[i][j];
      if (edgeIndex >= 0 && graph[monthNode(i)][edgeIndex].cap === 0) {
        return j;
      }
    }
    return -1;
  });
}
