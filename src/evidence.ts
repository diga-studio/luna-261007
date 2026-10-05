import type { AccessEvent, Triple } from './types.js';

/** Window length: 720 hours in milliseconds. */
export const WINDOW_MS = 720 * 60 * 60 * 1000;

/** Canonical key for a triple, used for set operations. */
export function tripleKey(t: Triple): string {
  // JSON encoding keeps keys collision-free for arbitrary component strings.
  return JSON.stringify([t.environment, t.resourceType, t.action]);
}

/**
 * Extract the deduplicated set of evidence triple keys from successful
 * accesses inside [now - WINDOW_MS, now). Failed accesses and accesses
 * outside the window are ignored; repeated accesses count once.
 */
export function collectEvidenceKeys(accesses: readonly AccessEvent[], now: number): Set<string> {
  const start = now - WINDOW_MS;
  const keys = new Set<string>();
  for (const event of accesses) {
    if (!event.success) continue;
    if (event.timestamp < start || event.timestamp >= now) continue;
    keys.add(tripleKey(event.triple));
  }
  return keys;
}
