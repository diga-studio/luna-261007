import { cluster, levenshtein, Id, Record } from '../src';

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
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

export function randomLetter(rnd: () => number): string {
  return String.fromCharCode(97 + Math.floor(rnd() * 26));
}

export function randomValue(rnd: () => number, minLen: number, maxLen: number): string {
  const len = minLen + Math.floor(rnd() * (maxLen - minLen + 1));
  let value = '';
  for (let i = 0; i < len; i++) value += randomLetter(rnd);
  return value;
}

/** Fisher-Yates shuffle (in place, returns the same array). */
export function shuffle<T>(items: T[], rnd: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

/** Independent reference: build the full similarity graph by brute force. */
export function bruteForceClusters(records: Record[]): Id[][] {
  const n = records.length;
  const parent = records.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = records[i].value;
      const b = records[j].value;
      const maxLen = Math.max(a.length, b.length);
      if (10 * levenshtein(a, b) <= maxLen) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const groups = new Map<number, Id[]>();
  records.forEach((record, i) => {
    const root = find(i);
    let group = groups.get(root);
    if (group === undefined) {
      group = [];
      groups.set(root, group);
    }
    group.push(record.id);
  });
  return [...groups.values()].filter((group) => group.length >= 2);
}

/** Canonical string form of a partition, independent of ordering. */
export function normalize(clusters: Id[][]): string {
  return JSON.stringify(
    clusters
      .map((ids) => ids.map(String).sort())
      .map((ids) => ids.join(','))
      .sort()
  );
}

export function clusteredPartitions(records: Record[]): string {
  return normalize(cluster(records).clusters);
}
