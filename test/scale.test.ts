import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FenceCatalog,
  Fence,
  GeoPoint,
  MATCH_TOLERANCE_METERS,
  greatCircleDistanceMeters,
} from "../src/index.js";

/**
 * Scale benchmark required by the spec:
 * - 200k fences, 20k queries at distinct positions, 2k interleaved
 *   single upsert/remove operations, total time (excluding initial load)
 *   must stay under 30 s.
 * - Run for two spatial distributions: globally spread, and concentrated
 *   north of 89.9°N. Radii mix 50 m and 5000 m.
 * - Every query in the workload has at most 20 hits (queries that would
 *   exceed this are rejected during workload generation).
 * - After the timed section, recorded results are checked against an
 *   independent brute-force replay of the same operation sequence.
 */

const FENCE_COUNT = 200_000;
const QUERY_COUNT = 20_000;
const MUTATION_COUNT = 2_000;
const TIME_BUDGET_MS = 30_000;
const MAX_HITS_PER_QUERY = 20;
const SAMPLE_EVERY = 40; // verify every 40th query against brute force

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bruteForceHits(
  fences: Iterable<Fence>,
  position: GeoPoint,
): string[] {
  const hits: string[] = [];
  for (const fence of fences) {
    const d = greatCircleDistanceMeters(position, fence.center);
    if (d <= fence.radiusMeters + MATCH_TOLERANCE_METERS) hits.push(fence.id);
  }
  return hits.sort();
}

type Op =
  | { kind: "query"; position: GeoPoint }
  | { kind: "upsert"; fence: Fence }
  | { kind: "remove"; id: string };

interface Scenario {
  name: string;
  makeCenter(rng: () => number): GeoPoint;
  makeQuery(rng: () => number): GeoPoint;
  makeRadius(rng: () => number): number;
}

const SCENARIOS: Scenario[] = [
  {
    name: "global",
    makeCenter: (rng) => {
      const z = rng() * 2 - 1;
      return {
        lat: (Math.asin(z) * 180) / Math.PI,
        lon: rng() * 360 - 180,
      };
    },
    makeQuery: (rng) => {
      const z = rng() * 2 - 1;
      return {
        lat: (Math.asin(z) * 180) / Math.PI,
        lon: rng() * 360 - 180,
      };
    },
    makeRadius: globalRadius,
  },
  {
    name: "polar(>=89.9N)",
    makeCenter: (rng) => ({
      lat: 89.9 + rng() * 0.1,
      lon: rng() * 360 - 180,
    }),
    // Mostly near the pole band, some spread worldwide: mixes hits/misses.
    makeQuery: (rng) =>
      rng() < 0.7
        ? { lat: 89.5 + rng() * 0.5, lon: rng() * 360 - 180 }
        : {
            lat: (Math.asin(rng() * 2 - 1) * 180) / Math.PI,
            lon: rng() * 360 - 180,
          },
    makeRadius: polarRadius,
  },
];

/** Global mix: 50 m, 5000 m, and values in between, all common. */
function globalRadius(rng: () => number): number {
  const pick = rng();
  if (pick < 0.3) return 50;
  if (pick < 0.6) return 5000;
  return 50 + rng() * 4950;
}

/**
 * Polar mix: 200k fences packed into the ~388 km^2 cap north of 89.9 N
 * cover ~515 fences/km^2, so the spec's "at most 20 hits per query"
 * constraint forces a bottom-heavy mix: mostly 50 m, some mid-range,
 * and a small number of 5000 m fences (both extremes present).
 */
function polarRadius(rng: () => number): number {
  const pick = rng();
  if (pick < 0.949) return 50;
  if (pick < 0.99975) return 50 + rng() * 450;
  return 5000;
}

function runScenario(scenario: Scenario, seed: number): void {
  const rng = makeRng(seed);

  // --- Initial catalog (load time is excluded from the budget). ---
  const fences: Fence[] = [];
  for (let i = 0; i < FENCE_COUNT; i++) {
    fences.push({
      id: `f${i}`,
      center: scenario.makeCenter(rng),
      radiusMeters: scenario.makeRadius(rng),
    });
  }
  const catalog = new FenceCatalog();
  const loadStart = performance.now();
  catalog.load(fences);
  const loadMs = performance.now() - loadStart;

  // --- Workload generation (untimed): queries with <= 20 hits. ---
  const ops: Op[] = [];
  let generated = 0;
  while (generated < QUERY_COUNT) {
    const position = scenario.makeQuery(rng);
    if (catalog.match(position).length <= MAX_HITS_PER_QUERY) {
      ops.push({ kind: "query", position });
      generated++;
    }
  }
  // Interleave mutations uniformly among the queries.
  let nextMutationId = 0;
  const liveIds: string[] = fences.map((f) => f.id);
  for (let m = 0; m < MUTATION_COUNT; m++) {
    const at = Math.floor(rng() * (ops.length + 1));
    const roll = rng();
    if (roll < 0.4) {
      // New fence (possibly reusing a previously removed id is covered
      // by the remove-then-add flow across iterations).
      ops.splice(at, 0, {
        kind: "upsert",
        fence: {
          id: `u${nextMutationId++}`,
          center: scenario.makeCenter(rng),
          radiusMeters: scenario.makeRadius(rng),
        },
      });
    } else if (roll < 0.8) {
      // Modify an existing fence: move it and/or change its radius.
      const id = liveIds[Math.floor(rng() * liveIds.length)]!;
      ops.splice(at, 0, {
        kind: "upsert",
        fence: {
          id,
          center: scenario.makeCenter(rng),
          radiusMeters: scenario.makeRadius(rng),
        },
      });
    } else {
      const id = liveIds[Math.floor(rng() * liveIds.length)]!;
      ops.splice(at, 0, { kind: "remove", id });
    }
  }

  // --- Timed section. ---
  const recorded = new Map<number, { position: GeoPoint; hits: string[] }>();
  let totalHits = 0;
  let hitQueries = 0;
  const start = performance.now();
  let queryIndex = 0;
  for (const op of ops) {
    if (op.kind === "query") {
      const hits = catalog.match(op.position);
      totalHits += hits.length;
      if (hits.length > 0) hitQueries++;
      if (queryIndex % SAMPLE_EVERY === 0) {
        recorded.set(queryIndex, { position: op.position, hits: hits.sort() });
      }
      queryIndex++;
    } else if (op.kind === "upsert") {
      catalog.upsert(op.fence);
    } else {
      catalog.remove(op.id);
    }
  }
  const elapsedMs = performance.now() - start;
  assert.equal(queryIndex, QUERY_COUNT);

  // --- Verification (untimed): replay the same ops on a reference model. ---
  const reference = new Map<string, Fence>();
  for (const fence of fences) reference.set(fence.id, fence);
  queryIndex = 0;
  let checked = 0;
  for (const op of ops) {
    if (op.kind === "query") {
      const sample = recorded.get(queryIndex);
      if (sample !== undefined) {
        const expected = bruteForceHits(reference.values(), op.position);
        assert.deepEqual(
          sample.hits,
          expected,
          `query #${queryIndex} at (${op.position.lat}, ${op.position.lon})`,
        );
        checked++;
      }
      queryIndex++;
    } else if (op.kind === "upsert") {
      reference.set(op.fence.id, op.fence);
    } else {
      reference.delete(op.id);
    }
  }
  assert.equal(catalog.size, reference.size);
  assert.ok(checked >= QUERY_COUNT / SAMPLE_EVERY - 1);

  console.log(
    `  [${scenario.name}] load=${loadMs.toFixed(0)}ms ` +
      `timed(${QUERY_COUNT} queries + ${MUTATION_COUNT} mutations)=${elapsedMs.toFixed(0)}ms ` +
      `hitQueries=${hitQueries} totalHits=${totalHits} ` +
      `verified ${checked} sampled queries vs brute force`,
  );
  assert.ok(hitQueries > 0, "workload must contain hit queries");
  assert.ok(
    elapsedMs <= TIME_BUDGET_MS,
    `timed section took ${elapsedMs.toFixed(0)}ms > ${TIME_BUDGET_MS}ms`,
  );
}

test("scale: 200k fences, 20k queries + 2k mutations under 30s", { timeout: 300_000 }, () => {
  runScenario(SCENARIOS[0]!, 1234);
  runScenario(SCENARIOS[1]!, 5678);
});
