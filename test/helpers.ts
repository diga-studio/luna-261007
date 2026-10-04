import { deepEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DependencyStore,
  SEVERITY_RANK,
  STALE_THRESHOLD_MS,
  type Dependency,
  type Observation,
  type OwnershipInterval,
  type Severity,
} from '../src/index.js';

export function freshStore(): { store: DependencyStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'depattr-'));
  const store = new DependencyStore(join(dir, 'test.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Independent reference implementation: recompute the graph from scratch. */
export function referenceGraph(
  timelines: ReadonlyMap<string, readonly OwnershipInterval[]>,
  observations: readonly Observation[],
  nowMs: number,
): Dependency[] {
  const ownerOf = (ip: string, atMs: number): string | null => {
    for (const interval of timelines.get(ip) ?? []) {
      if (interval.startMs <= atMs && atMs < interval.endMs) {
        return interval.assetId;
      }
    }
    return null;
  };
  const seen = new Set<string>();
  const edges = new Map<
    string,
    { src: string; dst: string; count: number; lastMs: number; rank: number }
  >();
  for (const obs of observations) {
    if (seen.has(obs.id)) {
      continue;
    }
    seen.add(obs.id);
    const src = ownerOf(obs.srcIp, obs.observedAtMs);
    const dst = ownerOf(obs.dstIp, obs.observedAtMs);
    if (src === null || dst === null || src === dst) {
      continue;
    }
    const key = `${src} ${dst}`;
    const rank = SEVERITY_RANK[obs.severity];
    const edge = edges.get(key);
    if (edge === undefined) {
      edges.set(key, { src, dst, count: 1, lastMs: obs.observedAtMs, rank });
    } else {
      edge.count += 1;
      edge.lastMs = Math.max(edge.lastMs, obs.observedAtMs);
      edge.rank = Math.max(edge.rank, rank);
    }
  }
  const rankToSeverity: Record<number, Severity> = {
    1: 'informational',
    2: 'standard',
    3: 'critical',
  };
  return [...edges.values()]
    .map((edge) => ({
      srcAssetId: edge.src,
      dstAssetId: edge.dst,
      supportCount: edge.count,
      lastObservedAtMs: edge.lastMs,
      severity: rankToSeverity[edge.rank]!,
      stale: nowMs - edge.lastMs >= STALE_THRESHOLD_MS,
    }))
    .sort((a, b) =>
      a.srcAssetId === b.srcAssetId
        ? a.dstAssetId < b.dstAssetId
          ? -1
          : 1
        : a.srcAssetId < b.srcAssetId
          ? -1
          : 1,
    );
}

export function assertGraphEquals(
  actual: Dependency[],
  expected: Dependency[],
): void {
  const sorted = (deps: Dependency[]) =>
    [...deps]
      .map((d) => ({
        srcAssetId: d.srcAssetId,
        dstAssetId: d.dstAssetId,
        supportCount: d.supportCount,
        lastObservedAtMs: d.lastObservedAtMs,
        severity: d.severity,
        stale: d.stale,
      }))
      .sort((a, b) =>
        a.srcAssetId === b.srcAssetId
          ? a.dstAssetId < b.dstAssetId
            ? -1
            : 1
          : a.srcAssetId < b.srcAssetId
            ? -1
            : 1,
      );
  deepEqual(sorted(actual), sorted(expected));
}
