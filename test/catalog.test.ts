import { test } from "node:test";
import assert from "node:assert/strict";
import { GeoFenceCatalog } from "../src/catalog.ts";
import { haversineDistanceMeters } from "../src/geo.ts";
import {
  EARTH_RADIUS_METERS,
  MATCH_TOLERANCE_METERS,
  type FenceInput,
} from "../src/types.ts";

function bruteForce(
  fences: FenceInput[],
  lat: number,
  lon: number
): string[] {
  const hits: string[] = [];
  for (const f of fences) {
    const d = haversineDistanceMeters(lat, lon, f.centerLat, f.centerLon);
    if (d <= f.radiusMeters + MATCH_TOLERANCE_METERS) {
      hits.push(f.id);
    }
  }
  return hits.sort();
}

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

function sortedMatch(
  catalog: GeoFenceCatalog,
  lat: number,
  lon: number
): string[] {
  return catalog.match(lat, lon).sort();
}

test("basic hit and miss", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([
    { id: "store-1", centerLat: 31.2304, centerLon: 121.4737, radiusMeters: 500 },
  ]);
  assert.deepEqual(sortedMatch(c, 31.2304, 121.4737), ["store-1"]);
  assert.deepEqual(c.match(31.3, 121.5), []);
  assert.equal(c.size, 1);
});

test("fence matching across the dateline", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([
    { id: "east", centerLat: 0, centerLon: 179.99, radiusMeters: 3000 },
    { id: "west", centerLat: 0, centerLon: -179.99, radiusMeters: 3000 },
    { id: "far", centerLat: 0, centerLon: 170, radiusMeters: 3000 },
  ]);
  assert.deepEqual(sortedMatch(c, 0, -179.995), ["east", "west"]);
  assert.deepEqual(sortedMatch(c, 0, 179.995), ["east", "west"]);
  assert.deepEqual(sortedMatch(c, 0, 180), ["east", "west"]);
});

test("fence covering the north pole", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([
    { id: "polar", centerLat: 89.98, centerLon: 0, radiusMeters: 5000 },
  ]);
  assert.deepEqual(sortedMatch(c, 90, 0), ["polar"]);
  assert.deepEqual(sortedMatch(c, 90, 120), ["polar"]);
  assert.deepEqual(sortedMatch(c, 89.99, -179), ["polar"]);
  assert.deepEqual(c.match(89.9, 0), []);
});

test("fence covering the south pole", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([
    { id: "antarctic", centerLat: -89.98, centerLon: 100, radiusMeters: 5000 },
  ]);
  assert.deepEqual(sortedMatch(c, -90, -30), ["antarctic"]);
  assert.deepEqual(sortedMatch(c, -89.99, -80), ["antarctic"]);
  assert.deepEqual(c.match(-89.9, 100), []);
});

test("1mm outward tolerance is applied", () => {
  const c = new GeoFenceCatalog();
  const radius = 1000;
  c.loadAll([{ id: "f", centerLat: 0, centerLon: 0, radiusMeters: radius }]);
  const lonFor = (meters: number) =>
    (meters / EARTH_RADIUS_METERS) * (180 / Math.PI);
  assert.deepEqual(sortedMatch(c, 0, lonFor(radius - 1)), ["f"]);
  assert.deepEqual(sortedMatch(c, 0, lonFor(radius + 0.0005)), ["f"]);
  assert.deepEqual(c.match(0, lonFor(radius + 0.002)), []);
});

test("overlapping and identical fences are all returned", () => {
  const c = new GeoFenceCatalog();
  const fences: FenceInput[] = [
    { id: "a", centerLat: 10, centerLon: 20, radiusMeters: 1000 },
    { id: "b", centerLat: 10, centerLon: 20, radiusMeters: 1000 },
    { id: "c", centerLat: 10.001, centerLon: 20.001, radiusMeters: 500 },
    { id: "d", centerLat: 10.005, centerLon: 20, radiusMeters: 5000 },
    { id: "e", centerLat: 11, centerLon: 21, radiusMeters: 100 },
  ];
  c.loadAll(fences);
  assert.deepEqual(sortedMatch(c, 10, 20), ["a", "b", "c", "d"]);
});

test("loadAll replaces the previous catalog", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([{ id: "old", centerLat: 0, centerLon: 0, radiusMeters: 100 }]);
  c.loadAll([{ id: "new", centerLat: 50, centerLon: 50, radiusMeters: 100 }]);
  assert.equal(c.size, 1);
  assert.deepEqual(c.match(0, 0), []);
  assert.deepEqual(sortedMatch(c, 50, 50), ["new"]);
});

test("upsert moves a fence across the dateline", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([{ id: "m", centerLat: 0, centerLon: 179, radiusMeters: 3000 }]);
  assert.deepEqual(sortedMatch(c, 0, 179), ["m"]);
  c.upsert([{ id: "m", centerLat: 0, centerLon: -179.99, radiusMeters: 3000 }]);
  assert.equal(c.size, 1);
  assert.deepEqual(c.match(0, 179), []);
  assert.deepEqual(sortedMatch(c, 0, -179.99), ["m"]);
  assert.deepEqual(sortedMatch(c, 0, 180), ["m"]);
});

test("upsert grows and shrinks radius with immediate effect", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([{ id: "r", centerLat: 0, centerLon: 0, radiusMeters: 100 }]);
  const lonFor = (meters: number) =>
    (meters / EARTH_RADIUS_METERS) * (180 / Math.PI);
  assert.deepEqual(c.match(0, lonFor(2000)), []);
  c.upsert([{ id: "r", centerLat: 0, centerLon: 0, radiusMeters: 5000 }]);
  assert.deepEqual(sortedMatch(c, 0, lonFor(2000)), ["r"]);
  c.upsert([{ id: "r", centerLat: 0, centerLon: 0, radiusMeters: 50 }]);
  assert.deepEqual(c.match(0, lonFor(2000)), []);
  assert.deepEqual(sortedMatch(c, 0, lonFor(30)), ["r"]);
});

test("deleted id can be reused at another location", () => {
  const c = new GeoFenceCatalog();
  c.loadAll([{ id: "x", centerLat: 10, centerLon: 10, radiusMeters: 200 }]);
  c.remove(["x"]);
  assert.equal(c.size, 0);
  assert.deepEqual(c.match(10, 10), []);
  c.upsert([{ id: "x", centerLat: -40, centerLon: -70, radiusMeters: 200 }]);
  assert.equal(c.size, 1);
  assert.deepEqual(c.match(10, 10), []);
  assert.deepEqual(sortedMatch(c, -40, -70), ["x"]);
});

test("batch upsert and remove", () => {
  const c = new GeoFenceCatalog();
  c.upsert([
    { id: "p", centerLat: 1, centerLon: 1, radiusMeters: 100 },
    { id: "q", centerLat: 2, centerLon: 2, radiusMeters: 100 },
    { id: "r", centerLat: 3, centerLon: 3, radiusMeters: 100 },
  ]);
  assert.equal(c.size, 3);
  c.remove(["p", "q", "missing"]);
  assert.equal(c.size, 1);
  assert.deepEqual(c.match(1, 1), []);
  assert.deepEqual(sortedMatch(c, 3, 3), ["r"]);
});

test("invalid inputs are rejected", () => {
  const c = new GeoFenceCatalog();
  assert.throws(() =>
    c.upsert([{ id: "", centerLat: 0, centerLon: 0, radiusMeters: 100 }])
  );
  assert.throws(() =>
    c.upsert([{ id: "a", centerLat: 91, centerLon: 0, radiusMeters: 100 }])
  );
  assert.throws(() =>
    c.upsert([{ id: "a", centerLat: 0, centerLon: -181, radiusMeters: 100 }])
  );
  assert.throws(() =>
    c.upsert([{ id: "a", centerLat: 0, centerLon: 0, radiusMeters: 49 }])
  );
  assert.throws(() =>
    c.upsert([{ id: "a", centerLat: 0, centerLon: 0, radiusMeters: 5001 }])
  );
  assert.throws(() => c.match(90.1, 0));
  assert.throws(() => c.match(0, 180.5));
  assert.equal(c.size, 0);
});

test("random cross-check against brute force (global + polar + dateline)", () => {
  const rand = mulberry32(42);
  const fences: FenceInput[] = [];
  for (let i = 0; i < 3000; i++) {
    const pick = rand();
    let lat: number;
    let lon: number;
    if (pick < 0.4) {
      lat = rand() * 180 - 90;
      lon = rand() * 360 - 180;
    } else if (pick < 0.7) {
      lat = rand() < 0.5 ? 89.9 + rand() * 0.1 : -89.9 - rand() * 0.1;
      lon = rand() * 360 - 180;
    } else {
      lat = rand() * 20 - 10;
      lon = (rand() < 0.5 ? 1 : -1) * (180 - rand() * 0.2);
    }
    const radius = 50 + Math.floor(rand() * 4951);
    fences.push({
      id: `f${i}`,
      centerLat: lat,
      centerLon: lon,
      radiusMeters: radius,
    });
  }
  const c = new GeoFenceCatalog();
  c.loadAll(fences);

  for (let q = 0; q < 400; q++) {
    const pick = rand();
    let lat: number;
    let lon: number;
    if (pick < 0.4) {
      lat = rand() * 180 - 90;
      lon = rand() * 360 - 180;
    } else if (pick < 0.7) {
      lat = rand() < 0.5 ? 89.9 + rand() * 0.1 : -89.9 - rand() * 0.1;
      lon = rand() * 360 - 180;
    } else {
      lat = rand() * 20 - 10;
      lon = (rand() < 0.5 ? 1 : -1) * (180 - rand() * 0.2);
    }
    const expected = bruteForce(fences, lat, lon);
    assert.deepEqual(sortedMatch(c, lat, lon), expected, `query ${q}`);
  }
});

test("sequential edits stay consistent with brute force", () => {
  const rand = mulberry32(7);
  const c = new GeoFenceCatalog();
  const live = new Map<string, FenceInput>();

  const queries: Array<[number, number]> = [];
  for (let i = 0; i < 60; i++) {
    queries.push([rand() * 180 - 90, rand() * 360 - 180]);
  }
  queries.push([0, 180], [0, -180], [90, 0], [-90, 45], [89.95, -179.9]);

  const checkAll = () => {
    const fences = [...live.values()];
    for (const [lat, lon] of queries) {
      assert.deepEqual(
        sortedMatch(c, lat, lon),
        bruteForce(fences, lat, lon),
        `query ${lat},${lon}`
      );
    }
  };

  for (let step = 0; step < 200; step++) {
    const op = rand();
    if (op < 0.45 || live.size === 0) {
      const id = `f${Math.floor(rand() * 120)}`;
      const fence: FenceInput = {
        id,
        centerLat: rand() * 180 - 90,
        centerLon: rand() * 360 - 180,
        radiusMeters: 50 + Math.floor(rand() * 4951),
      };
      c.upsert([fence]);
      live.set(id, fence);
    } else if (op < 0.7) {
      const ids = [...live.keys()];
      const id = ids[Math.floor(rand() * ids.length)];
      const fence: FenceInput = {
        id,
        centerLat: rand() * 180 - 90,
        centerLon: rand() * 360 - 180,
        radiusMeters: 50 + Math.floor(rand() * 4951),
      };
      c.upsert([fence]);
      live.set(id, fence);
    } else {
      const ids = [...live.keys()];
      const id = ids[Math.floor(rand() * ids.length)];
      c.remove([id]);
      live.delete(id);
    }
    checkAll();
  }
});
