import { ok } from 'node:assert/strict';
import test from 'node:test';
import type { Observation, OwnershipInterval, Severity } from '../src/index.js';
import { assertGraphEquals, freshStore, referenceGraph } from './helpers.js';

const ASSET_COUNT = 20_000;
const OBSERVATION_COUNT = 1_000_000;
const REVISION_ROUNDS = 100;
const SPAN_MS = 10 * 60 * 60 * 1000; // observations spread over 10 hours
const BUDGET_MS = 5_000;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ipOf = (i: number): string => `ip-${i}`;
const assetOf = (i: number): string => `asset-${i}`;

test(
  'scale: 1M observations, 20k assets, 100 revisions + reads within 5s',
  { timeout: 600_000 },
  () => {
    const rand = mulberry32(20261005);
    const { store, cleanup } = freshStore();
    try {
      // Initial timelines: one segment per IP, asset-i owns ip-i.
      const timelines = new Map<string, OwnershipInterval[]>();
      for (let i = 0; i < ASSET_COUNT; i += 1) {
        const timeline = [{ startMs: 0, endMs: SPAN_MS, assetId: assetOf(i) }];
        timelines.set(ipOf(i), timeline);
        store.reviseOwnership(ipOf(i), timeline);
      }

      // Generate and ingest 1M observations in chunks (not timed).
      const severities: Severity[] = ['informational', 'standard', 'critical'];
      const all: Observation[] = new Array(OBSERVATION_COUNT);
      const CHUNK = 50_000;
      let cursor = 0;
      let batch: Observation[] = [];
      for (let i = 0; i < OBSERVATION_COUNT; i += 1) {
        const observation: Observation = {
          id: `obs-${i}`,
          srcIp: ipOf(Math.floor(rand() * ASSET_COUNT)),
          dstIp: ipOf(Math.floor(rand() * ASSET_COUNT)),
          observedAtMs: Math.floor(rand() * SPAN_MS),
          severity: severities[Math.floor(rand() * 3)]!,
        };
        all[i] = observation;
        batch.push(observation);
        cursor += 1;
        if (batch.length === CHUNK) {
          store.ingest(batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        store.ingest(batch);
      }
      ok(cursor === OBSERVATION_COUNT);

      // Timed section: 100 single-IP revisions + reads of affected pairs.
      const start = performance.now();
      for (let round = 0; round < REVISION_ROUNDS; round += 1) {
        const ipIndex = (round * 173) % ASSET_COUNT;
        const ip = ipOf(ipIndex);
        const oldAsset = assetOf(ipIndex);
        const newAsset = assetOf((ipIndex + 10_000) % ASSET_COUNT);
        // Split into 3 segments; the middle 20% moves to another asset.
        const cut1 = Math.floor(SPAN_MS * 0.4);
        const cut2 = Math.floor(SPAN_MS * 0.6);
        const timeline: OwnershipInterval[] = [
          { startMs: 0, endMs: cut1, assetId: oldAsset },
          { startMs: cut1, endMs: cut2, assetId: newAsset },
          { startMs: cut2, endMs: SPAN_MS, assetId: oldAsset },
        ];
        timelines.set(ip, timeline);
        const result = store.reviseOwnership(ip, timeline);
        ok(result.reattributed <= 200, `revision changed ${result.reattributed} observations`);
        // Read the affected dependencies (both directions, old and new owner).
        const probe = all[round]!;
        const dstAsset = assetOf(Number(probe.dstIp.slice(3)));
        store.getDependency(oldAsset, dstAsset, SPAN_MS);
        store.getDependency(newAsset, dstAsset, SPAN_MS);
        store.getDependency(dstAsset, oldAsset, SPAN_MS);
        store.getDependency(dstAsset, newAsset, SPAN_MS);
      }
      const elapsed = performance.now() - start;
      console.log(
        `    100 revisions + affected reads: ${elapsed.toFixed(1)}ms (budget ${BUDGET_MS}ms)`,
      );
      ok(elapsed < BUDGET_MS, `revisions took ${elapsed}ms > ${BUDGET_MS}ms`);

      // Final graph must equal an independent full recomputation.
      assertGraphEquals(store.getGraph(SPAN_MS), referenceGraph(timelines, all, SPAN_MS));
    } finally {
      cleanup();
    }
  },
);
