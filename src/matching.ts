/**
 * Bipartite maximum matching (Hopcroft-Karp).
 * Left vertices are 0..nLeft-1, right vertices are 0..nRight-1.
 * adj[u] lists the right vertices adjacent to left vertex u.
 */

export interface Matching {
  size: number;
  /** matchLeft[u] = matched right vertex, or -1. */
  matchLeft: Int32Array;
  /** matchRight[v] = matched left vertex, or -1. */
  matchRight: Int32Array;
}

const UNMATCHED = -1;

export function maxMatching(
  nLeft: number,
  nRight: number,
  adj: readonly (readonly number[])[],
): Matching {
  const matchLeft = new Int32Array(nLeft).fill(UNMATCHED);
  const matchRight = new Int32Array(nRight).fill(UNMATCHED);
  const dist = new Int32Array(nLeft);
  let size = 0;

  // BFS builds layered graph from free left vertices.
  const bfs = (): boolean => {
    const queue: number[] = [];
    let foundFreeRight = false;
    for (let u = 0; u < nLeft; u++) {
      if (matchLeft[u] === UNMATCHED) {
        dist[u] = 0;
        queue.push(u);
      } else {
        dist[u] = UNMATCHED;
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head]!;
      for (const v of adj[u]!) {
        const w = matchRight[v]!;
        if (w === UNMATCHED) {
          foundFreeRight = true;
        } else if (dist[w] === UNMATCHED) {
          dist[w] = dist[u]! + 1;
          queue.push(w);
        }
      }
    }
    return foundFreeRight;
  };

  // DFS finds vertex-disjoint augmenting paths along the layering.
  const dfs = (u: number): boolean => {
    for (const v of adj[u]!) {
      const w = matchRight[v]!;
      if (w === UNMATCHED || (dist[w] === dist[u]! + 1 && dfs(w))) {
        matchLeft[u] = v;
        matchRight[v] = u;
        return true;
      }
    }
    dist[u] = UNMATCHED;
    return false;
  };

  while (bfs()) {
    for (let u = 0; u < nLeft; u++) {
      if (matchLeft[u] === UNMATCHED && dfs(u)) {
        size++;
      }
    }
  }
  return { size, matchLeft, matchRight };
}
