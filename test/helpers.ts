import { levenshtein } from "../src/levenshtein.js";
import type { Cluster, DedupRecord, Id } from "../src/types.js";

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function randomString(rng: () => number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(97 + randomInt(rng, 0, 25));
  }
  return out;
}

export function shuffle<T>(rng: () => number, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

function matchesThreshold(a: string, b: string): boolean {
  return 10 * levenshtein(a, b) <= Math.max(a.length, b.length);
}

/**
 * Independent reference: builds the full similarity graph by exhaustive
 * pairwise comparison and returns its connected components (size >= 2).
 */
export function bruteForceClusters(records: DedupRecord[]): Cluster[] {
  const n = records.length;
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (matchesThreshold(records[i].value, records[j].value)) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const groups = new Map<number, Id[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [records[i].id]);
    else list.push(records[i].id);
  }
  const clusters: Cluster[] = [];
  for (const ids of groups.values()) {
    if (ids.length >= 2) clusters.push({ ids });
  }
  return clusters;
}

function compareIds(a: Id, b: Id): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonical form of a cluster list, independent of input/output order. */
export function canonicalClusters(clusters: Cluster[]): string {
  return clusters
    .map((c) => [...c.ids].sort(compareIds).map(String).join(","))
    .sort()
    .join("|");
}
