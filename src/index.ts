import { collectEvidenceKeys, tripleKey } from './evidence.js';
import { selectGrantsToKeep } from './optimizer.js';
import type { Recommendation, Snapshot } from './types.js';

export type { AccessEvent, Grant, Recommendation, Snapshot, Triple } from './types.js';
export { WINDOW_MS } from './evidence.js';

/**
 * Analyze a snapshot and return the globally optimal keep/revoke
 * recommendation. Pure in-memory: no I/O, no persistence, no clocks
 * beyond the caller-provided `snapshot.now`.
 */
export function recommend(snapshot: Snapshot): Recommendation {
  const { grants, accesses, now } = snapshot;

  const seenIds = new Set<number>();
  for (const grant of grants) {
    if (!Number.isSafeInteger(grant.id) || grant.id <= 0) {
      throw new Error(`grant id must be a positive safe integer, got ${grant.id}`);
    }
    if (seenIds.has(grant.id)) {
      throw new Error(`duplicate grant id: ${grant.id}`);
    }
    seenIds.add(grant.id);
  }

  const evidence = collectEvidenceKeys(accesses, now);
  const grantIds = grants.map((g) => g.id);
  const coverages = grants.map((g) => new Set<string>(g.coverage.map(tripleKey)));

  const keepIds = new Set<number>(selectGrantsToKeep(grantIds, coverages, evidence));

  const keep: number[] = [];
  const revoke: number[] = [];
  for (const id of grantIds) {
    (keepIds.has(id) ? keep : revoke).push(id);
  }
  keep.sort((a, b) => a - b);
  revoke.sort((a, b) => a - b);
  return { keep, revoke };
}
