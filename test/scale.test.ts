import { test } from "node:test";
import assert from "node:assert/strict";
import { GeoFenceCatalog } from "../src/catalog.ts";
import { haversineDistanceMeters } from "../src/geo.ts";
import {
  MATCH_TOLERANCE_METERS,
  type FenceInput,
} from "../src/types.ts";

const FENCE_COUNT = 200_000;
const QUERY_COUNT = 20_000;
const OP_COUNT = 2_000;
const TIME_BUDGET_MS = 30_000;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scenario {
  name: string;
  randomLat(rand: () => number): number;
  randomLon(rand: () => number): number;
  randomRadius(rand: () => number): number;
}

const globalScenario: Scenario = {
  name: "global spread",
  randomLat: (rand) => (Math.asin(rand() * 2 - 1) * 180) / Math.PI,
  randomLon: (rand) => rand() * 360 - 180,
  randomRadius: (rand) => (rand() < 0.5 ? 50 : 5000),
};

const polarScenario: Scenario = {
  name: "concentrated above 89.9N",
  randomLat: (rand) => 90 - 0.1 * Math.sqrt(rand()),
  randomLon: (rand) => rand() * 360 - 180,
  randomRadius: (rand) => (rand() < 0.0002 ? 5000 : 50),
};

function runScenario(scenario: Scenario, seed: number): void {
  const rand = mulberry32(seed);
  const live = new Map<string, FenceInput>();

  const initial: FenceInput[] = [];
  for (let i = 0; i < FENCE_COUNT; i++) {
    const fence: FenceInput = {
      id: `f${i}`,
      centerLat: scenario.randomLat(rand),
      centerLon: scenario.randomLon(rand),
      radiusMeters: scenario.randomRadius(rand),
    };
    initial.push(fence);
    live.set(fence.id, fence);
  }

  const catalog = new GeoFenceCatalog();
  catalog.loadAll(initial);
  assert.equal(catalog.size, FENCE_COUNT);

  const liveIds = [...live.keys()];
  let nextExtraId = 0;
  let maxHits = 0;
  let totalHits = 0;

  const start = performance.now();
  for (let q = 0; q < QUERY_COUNT; q++) {
    let lat: number;
    let lon: number;
    if (q % 2 === 0) {
      const fence = live.get(liveIds[Math.floor(rand() * liveIds.length)])!;
      lat = fence.centerLat;
      lon = fence.centerLon;
    } else {
      lat = scenario.randomLat(rand);
      lon = scenario.randomLon(rand);
    }
    const hits = catalog.match(lat, lon);
    totalHits += hits.length;
    if (hits.length > maxHits) maxHits = hits.length;

    if (q % 10 === 0 && q / 10 < OP_COUNT) {
      const opKind = rand();
      if (opKind < 0.4) {
        const id = `extra${nextExtraId++}`;
        const fence: FenceInput = {
          id,
          centerLat: scenario.randomLat(rand),
          centerLon: scenario.randomLon(rand),
          radiusMeters: scenario.randomRadius(rand),
        };
        catalog.upsert([fence]);
        live.set(id, fence);
        liveIds.push(id);
      } else if (opKind < 0.8) {
        const id = liveIds[Math.floor(rand() * liveIds.length)];
        const fence: FenceInput = {
          id,
          centerLat: scenario.randomLat(rand),
          centerLon: scenario.randomLon(rand),
          radiusMeters: scenario.randomRadius(rand),
        };
        catalog.upsert([fence]);
        live.set(id, fence);
      } else {
        const idx = Math.floor(rand() * liveIds.length);
        const id = liveIds[idx];
        catalog.remove([id]);
        live.delete(id);
        liveIds[idx] = liveIds[liveIds.length - 1];
        liveIds.pop();
      }
    }
  }
  const elapsed = performance.now() - start;

  console.log(
    `[scale:${scenario.name}] ${QUERY_COUNT} queries + ${OP_COUNT} edits ` +
      `over ${FENCE_COUNT} fences took ${elapsed.toFixed(0)}ms ` +
      `(budget ${TIME_BUDGET_MS}ms), maxHits=${maxHits}, totalHits=${totalHits}`
  );
  assert.ok(
    elapsed < TIME_BUDGET_MS,
    `scenario ${scenario.name} took ${elapsed}ms`
  );

  const fences = [...live.values()];
  const verifySamples = 200;
  for (let i = 0; i < verifySamples; i++) {
    let lat: number;
    let lon: number;
    if (i % 2 === 0) {
      const fence = fences[Math.floor(rand() * fences.length)];
      lat = fence.centerLat;
      lon = fence.centerLon;
    } else {
      lat = scenario.randomLat(rand);
      lon = scenario.randomLon(rand);
    }
    const expected: string[] = [];
    for (const f of fences) {
      const d = haversineDistanceMeters(lat, lon, f.centerLat, f.centerLon);
      if (d <= f.radiusMeters + MATCH_TOLERANCE_METERS) {
        expected.push(f.id);
      }
    }
    assert.deepEqual(
      catalog.match(lat, lon).sort(),
      expected.sort(),
      `verify sample ${i} at ${lat},${lon}`
    );
  }
  console.log(
    `[scale:${scenario.name}] verified ${verifySamples} queries against brute force`
  );
}

test("scale: global spread with interleaved edits", { timeout: 120_000 }, () => {
  runScenario(globalScenario, 1001);
});

test("scale: polar concentration with interleaved edits", { timeout: 120_000 }, () => {
  runScenario(polarScenario, 2002);
});
