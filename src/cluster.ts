import type { ClusterResult, DedupRecord } from "./types.js";
import { boundedLevenshtein } from "./levenshtein.js";
import { GramIndex } from "./gramIndex.js";

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = new Array<number>(size);
    this.rank = new Array<number>(size).fill(0);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
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

function compareIds(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns the connected components (of size >= 2) of the graph where two
 * records are adjacent iff 10 * levenshtein(valueA, valueB) <= max length.
 *
 * Candidate retrieval uses an exact pigeonhole g-gram filter, so every
 * pair meeting the threshold is verified; no pair enumeration, no distance
 * matrix, no stored edge list.
 */
export function cluster(records: DedupRecord[]): ClusterResult {
  const n = records.length;
  const uf = new UnionFind(n);
  let distanceChecks = 0;

  // Merge identical values without any distance computation and keep one
  // representative slot per distinct value.
  const slotByValue = new Map<string, number>();
  const repIndex: number[] = [];
  const repValue: string[] = [];
  for (let i = 0; i < n; i++) {
    const value = records[i].value;
    const slot = slotByValue.get(value);
    if (slot === undefined) {
      slotByValue.set(value, repValue.length);
      repIndex.push(i);
      repValue.push(value);
    } else {
      uf.union(i, repIndex[slot]);
    }
  }

  const index = new GramIndex();
  for (let slot = 0; slot < repValue.length; slot++) {
    const value = repValue[slot];
    for (const other of index.candidates(value)) {
      const a = value;
      const b = repValue[other];
      const k = Math.floor(Math.max(a.length, b.length) / 10);
      distanceChecks++;
      if (10 * boundedLevenshtein(a, b, k) <= Math.max(a.length, b.length)) {
        uf.union(repIndex[slot], repIndex[other]);
      }
    }
    index.add(value, slot);
  }

  const members = new Map<number, (string | number)[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const list = members.get(root);
    if (list === undefined) {
      members.set(root, [records[i].id]);
    } else {
      list.push(records[i].id);
    }
  }

  const clusters = [];
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    ids.sort(compareIds);
    clusters.push({ ids });
  }
  clusters.sort((a, b) => compareIds(a.ids[0], b.ids[0]));

  return { clusters, stats: { distanceChecks } };
}
