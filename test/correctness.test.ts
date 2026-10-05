import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FenceCatalog,
  Fence,
  GeoPoint,
  MATCH_TOLERANCE_METERS,
  greatCircleDistanceMeters,
} from "../src/index.js";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
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

/** Wrap a longitude into [-180, 180). */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function bruteForce(
  fences: readonly Fence[],
  position: GeoPoint,
): string[] {
  const hits: string[] = [];
  for (const fence of fences) {
    const d = greatCircleDistanceMeters(position, fence.center);
    if (d <= fence.radiusMeters + MATCH_TOLERANCE_METERS) hits.push(fence.id);
  }
  return hits.sort();
}

function assertMatch(
  catalog: FenceCatalog,
  fences: readonly Fence[],
  position: GeoPoint,
): void {
  const expected = bruteForce(fences, position);
  const actual = catalog.match(position).sort();
  assert.deepEqual(
    actual,
    expected,
    `mismatch at (${position.lat}, ${position.lon})`,
  );
}

function randomGlobalFences(rng: () => number, count: number): Fence[] {
  const fences: Fence[] = [];
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: z = sin(lat) uniform in [-1, 1].
    const z = rng() * 2 - 1;
    fences.push({
      id: `f${i}`,
      center: {
        lat: (Math.asin(z) * 180) / Math.PI,
        lon: rng() * 360 - 180,
      },
      radiusMeters: 50 + rng() * 4950,
    });
  }
  return fences;
}

test("randomized global catalog matches brute force", () => {
  const rng = makeRng(42);
  const fences = randomGlobalFences(rng, 3000);
  const catalog = new FenceCatalog();
  catalog.load(fences);
  for (let q = 0; q < 500; q++) {
    const z = rng() * 2 - 1;
    assertMatch(catalog, fences, {
      lat: (Math.asin(z) * 180) / Math.PI,
      lon: rng() * 360 - 180,
    });
  }
});

test("randomized polar catalog matches brute force", () => {
  const rng = makeRng(7);
  const fences: Fence[] = [];
  for (let i = 0; i < 3000; i++) {
    fences.push({
      id: `p${i}`,
      center: { lat: 89.9 + rng() * 0.1, lon: rng() * 360 - 180 },
      radiusMeters: 50 + rng() * 4950,
    });
  }
  const catalog = new FenceCatalog();
  catalog.load(fences);
  for (let q = 0; q < 500; q++) {
    assertMatch(catalog, fences, {
      lat: 89.9 + rng() * 0.1,
      lon: rng() * 360 - 180,
    });
  }
});

test("randomized antimeridian catalog matches brute force", () => {
  const rng = makeRng(99);
  const fences: Fence[] = [];
  for (let i = 0; i < 3000; i++) {
    const side = rng() < 0.5 ? 1 : -1;
    fences.push({
      id: `a${i}`,
      center: {
        lat: rng() * 120 - 60,
        lon: side * (179 + rng()),
      },
      radiusMeters: 50 + rng() * 4950,
    });
  }
  const catalog = new FenceCatalog();
  catalog.load(fences);
  for (let q = 0; q < 500; q++) {
    const side = rng() < 0.5 ? 1 : -1;
    assertMatch(catalog, fences, {
      lat: rng() * 120 - 60,
      lon: side * (179 + rng()),
    });
  }
});

test("antimeridian: fence at +180 equals fence at -180", () => {
  const catalog = new FenceCatalog();
  catalog.load([
    { id: "east", center: { lat: 10, lon: 180 }, radiusMeters: 1000 },
    { id: "west", center: { lat: 10, lon: -180 }, radiusMeters: 1000 },
  ]);
  const hits = catalog.match({ lat: 10, lon: -180 }).sort();
  assert.deepEqual(hits, ["east", "west"]);
  const hits2 = catalog.match({ lat: 10, lon: 180 }).sort();
  assert.deepEqual(hits2, ["east", "west"]);
});

test("antimeridian: short way across the line", () => {
  const catalog = new FenceCatalog();
  catalog.load([
    { id: "f", center: { lat: 0, lon: 179.9999 }, radiusMeters: 100 },
  ]);
  // ~11 m across the line, well inside 100 m.
  assert.deepEqual(catalog.match({ lat: 0, lon: -179.9999 }), ["f"]);
});

test("poles: all longitudes are the same point", () => {
  const catalog = new FenceCatalog();
  catalog.load([
    { id: "np", center: { lat: 90, lon: 0 }, radiusMeters: 2000 },
    { id: "sp", center: { lat: -90, lon: 100 }, radiusMeters: 2000 },
  ]);
  for (const lon of [-180, -90, 0, 90, 179.9]) {
    assert.deepEqual(catalog.match({ lat: 90, lon }), ["np"]);
    assert.deepEqual(catalog.match({ lat: -90, lon }), ["sp"]);
  }
  // 1 km from the pole at an arbitrary longitude: inside both caps.
  assert.deepEqual(catalog.match({ lat: 89.991, lon: -45 }), ["np"]);
  assert.deepEqual(catalog.match({ lat: -89.991, lon: 45 }), ["sp"]);
});

test("boundary tolerance: radius + 1mm hits, radius + 2mm misses", () => {
  const radius = 1000;
  const catalog = new FenceCatalog();
  catalog.load([{ id: "f", center: { lat: 0, lon: 0 }, radiusMeters: radius }]);
  const degPerMeter = 180 / (Math.PI * 6371008.8);
  const at = (meters: number): GeoPoint => ({
    lat: meters * degPerMeter,
    lon: 0,
  });
  assert.deepEqual(catalog.match(at(radius - 1)), ["f"]);
  assert.deepEqual(catalog.match(at(radius)), ["f"]);
  assert.deepEqual(catalog.match(at(radius + 0.0005)), ["f"]);
  assert.deepEqual(catalog.match(at(radius + 0.001)), ["f"]);
  assert.deepEqual(catalog.match(at(radius + 0.002)), []);
  assert.deepEqual(catalog.match(at(radius + 1)), []);
});

test("overlapping and identical fences all match", () => {
  const catalog = new FenceCatalog();
  const fences: Fence[] = [
    { id: "a", center: { lat: 30, lon: 120 }, radiusMeters: 500 },
    { id: "b", center: { lat: 30, lon: 120 }, radiusMeters: 500 },
    { id: "c", center: { lat: 30, lon: 120 }, radiusMeters: 5000 },
    { id: "d", center: { lat: 30.001, lon: 120.001 }, radiusMeters: 500 },
    { id: "far", center: { lat: 31, lon: 121 }, radiusMeters: 500 },
  ];
  catalog.load(fences);
  assertMatch(catalog, fences, { lat: 30, lon: 120 });
  assert.deepEqual(catalog.match({ lat: 30, lon: 120 }).sort(), [
    "a",
    "b",
    "c",
    "d",
  ]);
});

test("upsert moves center: old range stops matching immediately", () => {
  const catalog = new FenceCatalog();
  catalog.load([
    { id: "f", center: { lat: 0, lon: 0 }, radiusMeters: 1000 },
  ]);
  assert.deepEqual(catalog.match({ lat: 0, lon: 0 }), ["f"]);
  catalog.upsert({ id: "f", center: { lat: 10, lon: 10 }, radiusMeters: 1000 });
  assert.deepEqual(catalog.match({ lat: 0, lon: 0 }), []);
  assert.deepEqual(catalog.match({ lat: 10, lon: 10 }), ["f"]);
  assert.equal(catalog.size, 1);
});

test("upsert across the antimeridian", () => {
  const catalog = new FenceCatalog();
  catalog.load([
    { id: "f", center: { lat: 0, lon: 179.999 }, radiusMeters: 500 },
  ]);
  assert.deepEqual(catalog.match({ lat: 0, lon: -179.999 }), ["f"]);
  catalog.upsert({ id: "f", center: { lat: 0, lon: -179 }, radiusMeters: 500 });
  assert.deepEqual(catalog.match({ lat: 0, lon: 179.999 }), []);
  assert.deepEqual(catalog.match({ lat: 0, lon: -179 }), ["f"]);
});

test("upsert shrinks and grows radius", () => {
  const catalog = new FenceCatalog();
  catalog.load([{ id: "f", center: { lat: 0, lon: 0 }, radiusMeters: 5000 }]);
  const degPerMeter = 180 / (Math.PI * 6371008.8);
  const far = { lat: 4000 * degPerMeter, lon: 0 };
  assert.deepEqual(catalog.match(far), ["f"]);
  catalog.upsert({ id: "f", center: { lat: 0, lon: 0 }, radiusMeters: 50 });
  assert.deepEqual(catalog.match(far), []);
  catalog.upsert({ id: "f", center: { lat: 0, lon: 0 }, radiusMeters: 5000 });
  assert.deepEqual(catalog.match(far), ["f"]);
});

test("remove deletes; id can be reused elsewhere", () => {
  const catalog = new FenceCatalog();
  catalog.load([{ id: "f", center: { lat: 0, lon: 0 }, radiusMeters: 500 }]);
  assert.equal(catalog.remove("f"), true);
  assert.equal(catalog.remove("f"), false);
  assert.deepEqual(catalog.match({ lat: 0, lon: 0 }), []);
  catalog.upsert({ id: "f", center: { lat: 50, lon: 50 }, radiusMeters: 500 });
  assert.deepEqual(catalog.match({ lat: 0, lon: 0 }), []);
  assert.deepEqual(catalog.match({ lat: 50, lon: 50 }), ["f"]);
  assert.equal(catalog.size, 1);
});

test("load replaces the whole catalog", () => {
  const catalog = new FenceCatalog();
  catalog.load([{ id: "old", center: { lat: 0, lon: 0 }, radiusMeters: 500 }]);
  catalog.load([{ id: "new", center: { lat: 1, lon: 1 }, radiusMeters: 500 }]);
  assert.equal(catalog.size, 1);
  assert.deepEqual(catalog.match({ lat: 0, lon: 0 }), []);
  assert.deepEqual(catalog.match({ lat: 1, lon: 1 }), ["new"]);
});

test("randomized mutation sequence stays consistent with brute force", () => {
  const rng = makeRng(2024);
  const catalog = new FenceCatalog();
  const live = new Map<string, Fence>();
  let nextId = 0;
  const randomFence = (id: string): Fence => ({
    id,
    center: { lat: 89.9 + rng() * 0.1, lon: wrapLon(175 + rng() * 10) },
    radiusMeters: 50 + rng() * 4950,
  });
  for (let step = 0; step < 400; step++) {
    const op = rng();
    if (op < 0.45 || live.size === 0) {
      const fence = randomFence(`m${nextId++}`);
      catalog.upsert(fence);
      live.set(fence.id, fence);
    } else if (op < 0.75) {
      const keys = [...live.keys()];
      const id = keys[Math.floor(rng() * keys.length)]!;
      const fence = randomFence(id);
      catalog.upsert(fence);
      live.set(id, fence);
    } else {
      const keys = [...live.keys()];
      const id = keys[Math.floor(rng() * keys.length)]!;
      catalog.remove(id);
      live.delete(id);
    }
    const fences = [...live.values()];
    assertMatch(catalog, fences, {
      lat: 89.9 + rng() * 0.1,
      lon: wrapLon(175 + rng() * 10),
    });
  }
});

test("validation rejects invalid input", () => {
  const catalog = new FenceCatalog();
  assert.throws(
    () => catalog.upsert({ id: "x", center: { lat: 91, lon: 0 }, radiusMeters: 100 }),
    RangeError,
  );
  assert.throws(
    () => catalog.upsert({ id: "x", center: { lat: 0, lon: 181 }, radiusMeters: 100 }),
    RangeError,
  );
  assert.throws(
    () => catalog.upsert({ id: "x", center: { lat: 0, lon: 0 }, radiusMeters: 49 }),
    RangeError,
  );
  assert.throws(
    () => catalog.upsert({ id: "x", center: { lat: 0, lon: 0 }, radiusMeters: 5001 }),
    RangeError,
  );
  assert.throws(
    () => catalog.upsert({ id: "", center: { lat: 0, lon: 0 }, radiusMeters: 100 }),
    TypeError,
  );
  assert.throws(
    () => catalog.upsert({ id: "x", center: { lat: NaN, lon: 0 }, radiusMeters: 100 }),
    RangeError,
  );
  assert.throws(() => catalog.match({ lat: 0, lon: Infinity }), RangeError);
  // Failed upsert must not corrupt the catalog.
  assert.equal(catalog.size, 0);
});

test("massive overlap: every covering fence is returned", () => {
  const rng = makeRng(31337);
  const catalog = new FenceCatalog();
  const fences: Fence[] = [];
  // 20k fences all covering the same point, spread around it.
  for (let i = 0; i < 20000; i++) {
    fences.push({
      id: `o${i}`,
      center: { lat: 45 + rng() * 0.01, lon: rng() * 0.01 },
      radiusMeters: 5000,
    });
  }
  catalog.load(fences);
  const hits = catalog.match({ lat: 45.005, lon: 0.005 });
  assert.equal(hits.length, fences.length);
  assert.deepEqual(hits.sort(), fences.map((f) => f.id).sort());
});

test("load with duplicate ids: last one wins, no stale entries", () => {
  const catalog = new FenceCatalog();
  catalog.load([
    { id: "dup", center: { lat: 0, lon: 0 }, radiusMeters: 500 },
    { id: "dup", center: { lat: 40, lon: 40 }, radiusMeters: 500 },
  ]);
  assert.equal(catalog.size, 1);
  assert.deepEqual(catalog.match({ lat: 0, lon: 0 }), []);
  assert.deepEqual(catalog.match({ lat: 40, lon: 40 }), ["dup"]);
  catalog.remove("dup");
  assert.equal(catalog.size, 0);
  assert.deepEqual(catalog.match({ lat: 40, lon: 40 }), []);
});
