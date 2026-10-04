import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionStore } from '../src/index.js';
import type { Observation, OwnershipInterval, Severity } from '../src/index.js';

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const ASSET_COUNT = 20_000;
const IP_COUNT = 40_000;
const OBSERVATION_COUNT = 1_000_000;
const REVISION_COUNT = 100;
const MAX_AFFECTED_PER_REVISION = 200;
const BUDGET_MS = 5_000;

/** Deterministic PRNG (mulberry32) so the perf run is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test(
  '100 single-IP revisions with affected-dependency reads stay within budget at 1M observations',
  { timeout: 600_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'netdep-perf-'));
    const store = new AttributionStore(join(dir, 'perf.db'));
    const rand = rng(42);

    try {
      // --- Initial import (not timed) -------------------------------------
      const assets = Array.from({ length: ASSET_COUNT }, (_, i) => `asset-${i}`);
      const ips = Array.from({ length: IP_COUNT }, (_, i) => `ip-${i}`);
      const ipOwner = ips.map((_, i) => assets[i % ASSET_COUNT]);

      // Each IP starts with a single open-ended ownership interval.
      for (let i = 0; i < IP_COUNT; i++) {
        store.reviseTimeline(ips[i], [{ startMs: T0, endMs: null, assetId: ipOwner[i] }]);
      }

      const severities: Severity[] = ['critical', 'standard', 'informational'];
      const ipUseCount = new Map<string, number>();
      const batch: Observation[] = [];
      const flush = () => {
        if (batch.length > 0) {
          store.ingest(batch);
          batch.length = 0;
        }
      };
      for (let i = 0; i < OBSERVATION_COUNT; i++) {
        const srcIp = ips[Math.floor(rand() * IP_COUNT)];
        let dstIp = ips[Math.floor(rand() * IP_COUNT)];
        if (dstIp === srcIp) dstIp = ips[(IP_COUNT + ips.indexOf(srcIp) - 1) % IP_COUNT];
        ipUseCount.set(srcIp, (ipUseCount.get(srcIp) ?? 0) + 1);
        ipUseCount.set(dstIp, (ipUseCount.get(dstIp) ?? 0) + 1);
        batch.push({
          id: `obs-${i}`,
          srcIp,
          dstIp,
          observedAtMs: T0 + Math.floor(rand() * 500 * HOUR),
          severity: severities[Math.floor(rand() * 3)],
        });
        if (batch.length >= 10_000) flush();
      }
      flush();

      // Revision targets: IPs whose total observation count stays within the
      // 200-observation-per-revision limit.
      const candidates = ips.filter(
        (ip) => (ipUseCount.get(ip) ?? 0) <= MAX_AFFECTED_PER_REVISION,
      );
      assert.ok(
        candidates.length >= REVISION_COUNT,
        `need at least ${REVISION_COUNT} revision candidates, got ${candidates.length}`,
      );

      // --- Timed section: 100 revisions + reads ----------------------------
      const nowMs = T0 + 600 * HOUR;
      const start = performance.now();
      for (let r = 0; r < REVISION_COUNT; r++) {
        const ip = candidates[r];
        const oldAsset = ipOwner[ips.indexOf(ip)];
        let newAsset = assets[Math.floor(rand() * ASSET_COUNT)];
        if (newAsset === oldAsset) newAsset = assets[(ASSET_COUNT + assets.indexOf(newAsset) - 1) % ASSET_COUNT];

        // New timeline: two segments, ownership of the middle window moves
        // to another asset (bounded number of affected observations).
        const windowStart = T0 + Math.floor(rand() * 400) * HOUR;
        const timeline: OwnershipInterval[] = [
          { startMs: T0, endMs: windowStart, assetId: oldAsset },
          { startMs: windowStart, endMs: windowStart + 50 * HOUR, assetId: newAsset },
          { startMs: windowStart + 50 * HOUR, endMs: null, assetId: oldAsset },
        ];
        store.reviseTimeline(ip, timeline);

        // Read the affected dependencies.
        store.getDependency(oldAsset, newAsset, nowMs);
        store.getDependency(newAsset, oldAsset, nowMs);
        for (let k = 0; k < 4; k++) {
          store.getDependency(oldAsset, assets[Math.floor(rand() * ASSET_COUNT)], nowMs);
          store.getDependency(newAsset, assets[Math.floor(rand() * ASSET_COUNT)], nowMs);
        }
      }
      const elapsed = performance.now() - start;

      console.log(
        `perf: ${REVISION_COUNT} revisions + reads over ${OBSERVATION_COUNT} observations ` +
          `took ${elapsed.toFixed(1)}ms (budget ${BUDGET_MS}ms)`,
      );
      assert.ok(
        elapsed < BUDGET_MS,
        `revision+read cycle took ${elapsed.toFixed(1)}ms, budget is ${BUDGET_MS}ms`,
      );

      // Sanity: the graph is still readable and non-trivial after revisions.
      const graph = store.getGraph(nowMs);
      assert.ok(graph.length > 0);
      for (const dep of graph) {
        assert.ok(dep.supportCount > 0);
        assert.notEqual(dep.srcAsset, dep.dstAsset);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
