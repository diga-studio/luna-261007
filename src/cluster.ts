import { levenshtein } from './levenshtein';
import type { ClusterResult, Id, Record } from './index';

/**
 * Pigeonhole candidate filter: any pair within edit distance K shares at
 * least one of the K+1 contiguous segments of either string (an edit can
 * break at most one segment). K = 3 covers every pair that can reach the
 * similarity threshold for values of length 8..32, since
 * 10 * d <= maxLen <= 32 implies d <= 3.
 * The filter is exact: it never prunes a pair that meets the threshold.
 */
const SEGMENT_COUNT = 4;

function segmentsOf(value: string): string[] {
  const len = value.length;
  if (len < SEGMENT_COUNT) return [value];
  const base = Math.floor(len / SEGMENT_COUNT);
  const extra = len % SEGMENT_COUNT;
  const parts: string[] = [];
  let pos = 0;
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const size = base + (i < extra ? 1 : 0);
    parts.push(value.slice(pos, pos + size));
    pos += size;
  }
  return parts;
}

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = new Array<number>(size);
    this.rank = new Array<number>(size).fill(0);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
  }
}

function compareIds(a: Id, b: Id): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Clusters records by fuzzy value similarity. Two records are similar iff
 * 10 * levenshtein(a, b) <= max(lenA, lenB) (i.e. similarity >= 0.9).
 * The result is exactly the set of connected components (of size >= 2) of
 * that similarity graph; transitive members share a cluster even when they
 * are not directly similar.
 */
export function cluster(records: Record[]): ClusterResult {
  let distanceChecks = 0;

  // Merge identical values up front: same value is distance 0, so all
  // records sharing a value belong to one component by definition.
  const values: string[] = [];
  const idsByValue: Id[][] = [];
  const repByValue = new Map<string, number>();
  for (const record of records) {
    let rep = repByValue.get(record.value);
    if (rep === undefined) {
      rep = values.length;
      repByValue.set(record.value, rep);
      values.push(record.value);
      idsByValue.push([]);
    }
    idsByValue[rep].push(record.id);
  }

  const uf = new UnionFind(values.length);
  const segmentIndex = new Map<string, number[]>();
  const segmentLengths = new Set<number>();
  const candidates = new Set<number>();

  for (let rep = 0; rep < values.length; rep++) {
    const value = values[rep];

    // Retrieve candidates: every previously indexed rep that shares at
    // least one segment-length substring with this value.
    candidates.clear();
    for (const len of segmentLengths) {
      if (value.length < len) continue;
      for (let pos = 0; pos + len <= value.length; pos++) {
        const hits = segmentIndex.get(value.slice(pos, pos + len));
        if (hits === undefined) continue;
        for (const other of hits) {
          if (other !== rep) candidates.add(other);
        }
      }
    }

    // Verify candidates with an exact (early-exiting) distance check.
    for (const other of candidates) {
      const otherValue = values[other];
      const maxLen = Math.max(value.length, otherValue.length);
      const maxDistance = Math.floor(maxLen / 10);
      distanceChecks++;
      const d = levenshtein(value, otherValue, maxDistance);
      if (10 * d <= maxLen) uf.union(rep, other);
    }

    // Index this rep's segments for later queries.
    const seen = new Set<string>();
    for (const segment of segmentsOf(value)) {
      if (segment.length === 0 || seen.has(segment)) continue;
      seen.add(segment);
      segmentLengths.add(segment.length);
      const bucket = segmentIndex.get(segment);
      if (bucket === undefined) segmentIndex.set(segment, [rep]);
      else bucket.push(rep);
    }
  }

  // Expand components into id clusters, dropping singletons.
  const clusterIds = new Map<number, Id[]>();
  for (let rep = 0; rep < values.length; rep++) {
    const root = uf.find(rep);
    let list = clusterIds.get(root);
    if (list === undefined) {
      list = [];
      clusterIds.set(root, list);
    }
    for (const id of idsByValue[rep]) list.push(id);
  }

  const clusters: Id[][] = [];
  for (const ids of clusterIds.values()) {
    if (ids.length < 2) continue;
    ids.sort(compareIds);
    clusters.push(ids);
  }
  clusters.sort((a, b) => compareIds(a[0], b[0]));

  return { clusters, stats: { distanceChecks } };
}
