import { levenshtein } from './levenshtein';
import { cluster } from './cluster';

export type Id = string | number;

export interface Record {
  id: Id;
  value: string;
}

export interface ClusterStats {
  distanceChecks: number;
}

export interface ClusterResult {
  clusters: Id[][];
  stats: ClusterStats;
}

/** Similarity threshold: similar iff 10 * distance <= max(lenA, lenB). */
export const SIMILARITY_THRESHOLD = 0.9;

/** 1 - levenshtein(a, b) / max(lenA, lenB). */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export { cluster, levenshtein };
