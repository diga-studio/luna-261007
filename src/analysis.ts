import { maxMatching } from "./matching.js";
import type { AnalysisResult, Pair } from "./types.js";

/** Immutable candidate snapshot plus accepted rulings. */
export interface Snapshot {
  transactionIds: readonly string[];
  journalIds: readonly string[];
  candidatePairs: readonly Pair[];
}

interface IndexedGraph {
  nLeft: number;
  nRight: number;
  /** edges[i] = [leftIndex, rightIndex], deduplicated. */
  edges: readonly (readonly [number, number])[];
  leftIndex: ReadonlyMap<string, number>;
  rightIndex: ReadonlyMap<string, number>;
}

function buildGraph(snapshot: Snapshot): IndexedGraph {
  const leftIndex = new Map<string, number>();
  snapshot.transactionIds.forEach((id, i) => leftIndex.set(id, i));
  const rightIndex = new Map<string, number>();
  snapshot.journalIds.forEach((id, i) => rightIndex.set(id, i));
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const p of snapshot.candidatePairs) {
    const u = leftIndex.get(p.transactionId)!;
    const v = rightIndex.get(p.journalId)!;
    const key = u + ":" + v;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([u, v]);
    }
  }
  return { nLeft: snapshot.transactionIds.length, nRight: snapshot.journalIds.length, edges, leftIndex, rightIndex };
}

/**
 * Maximum matching size of the graph after removing the given vertices
 * and (optionally) one edge (by index into graph.edges, -1 = none).
 */
function matchingSizeWithout(
  graph: IndexedGraph,
  leftOut: ReadonlySet<number>,
  rightOut: ReadonlySet<number>,
  edgeOut: number,
): number {
  const adj: number[][] = Array.from({ length: graph.nLeft }, () => []);
  for (let i = 0; i < graph.edges.length; i++) {
    if (i === edgeOut) continue;
    const [u, v] = graph.edges[i]!;
    if (leftOut.has(u) || rightOut.has(v)) continue;
    adj[u]!.push(v);
  }
  return maxMatching(graph.nLeft, graph.nRight, adj).size;
}

function toIndexPairs(
  graph: IndexedGraph,
  pairs: readonly Pair[],
): { left: Set<number>; right: Set<number>; indices: [number, number][] } {
  const left = new Set<number>();
  const right = new Set<number>();
  const indices: [number, number][] = [];
  for (const p of pairs) {
    const u = graph.leftIndex.get(p.transactionId);
    const v = graph.rightIndex.get(p.journalId);
    if (u === undefined || v === undefined) {
      throw new Error(`ruling references unknown id: ${p.transactionId} / ${p.journalId}`);
    }
    left.add(u);
    right.add(v);
    indices.push([u, v]);
  }
  return { left, right, indices };
}

/**
 * Whether the given rulings can all belong to one optimal solution:
 * they must be candidate edges, endpoint-disjoint, and not reduce K.
 */
export function rulingsAreFeasible(
  snapshot: Snapshot,
  rulings: readonly Pair[],
): boolean {
  const graph = buildGraph(snapshot);
  const k = matchingSizeWithout(graph, new Set(), new Set(), -1);
  const candidateKeys = new Set(graph.edges.map(([u, v]) => u + ":" + v));
  const { left, right, indices } = toIndexPairs(graph, rulings);
  if (left.size !== rulings.length || right.size !== rulings.length) {
    return false; // endpoint conflict inside the batch
  }
  for (const [u, v] of indices) {
    if (!candidateKeys.has(u + ":" + v)) {
      return false; // not a candidate edge, can never be in an optimal solution
    }
  }
  if (rulings.length > k) {
    return false;
  }
  return matchingSizeWithout(graph, left, right, -1) === k - rulings.length;
}

/**
 * Full analysis over all optimal solutions (size-K matchings) that contain
 * every accepted ruling. Assumes `rulings` is feasible (see rulingsAreFeasible);
 * sessions guarantee this by construction.
 */
export function analyzeSnapshot(
  snapshot: Snapshot,
  rulings: readonly Pair[],
): AnalysisResult {
  const graph = buildGraph(snapshot);
  const k = matchingSizeWithout(graph, new Set(), new Set(), -1);
  const forced = toIndexPairs(graph, rulings);
  const kRem = k - rulings.length;

  const certain: Pair[] = [...rulings];
  const possible: Pair[] = [...rulings];
  const tIds = snapshot.transactionIds;
  const jIds = snapshot.journalIds;

  for (let i = 0; i < graph.edges.length; i++) {
    const [u, v] = graph.edges[i]!;
    if (forced.left.has(u) || forced.right.has(v)) continue;
    // Possible: forcing this edge still allows K (on the remaining graph).
    const withForced = matchingSizeWithout(
      graph,
      new Set([...forced.left, u]),
      new Set([...forced.right, v]),
      -1,
    );
    if (withForced === kRem - 1) {
      possible.push({ transactionId: tIds[u]!, journalId: jIds[v]! });
      // Certain: removing this edge drops the maximum below K.
      if (matchingSizeWithout(graph, forced.left, forced.right, i) < kRem) {
        certain.push({ transactionId: tIds[u]!, journalId: jIds[v]! });
      }
    }
  }

  const unmatchedT: string[] = [];
  for (let u = 0; u < graph.nLeft; u++) {
    if (forced.left.has(u)) continue;
    const size = matchingSizeWithout(graph, new Set([...forced.left, u]), forced.right, -1);
    if (size === kRem) unmatchedT.push(tIds[u]!);
  }
  const unmatchedJ: string[] = [];
  for (let v = 0; v < graph.nRight; v++) {
    if (forced.right.has(v)) continue;
    const size = matchingSizeWithout(graph, forced.left, new Set([...forced.right, v]), -1);
    if (size === kRem) unmatchedJ.push(jIds[v]!);
  }

  return {
    k,
    certainPairs: certain,
    possiblePairs: possible,
    possiblyUnmatchedTransactionIds: unmatchedT,
    possiblyUnmatchedJournalIds: unmatchedJ,
  };
}
