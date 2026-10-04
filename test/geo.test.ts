import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineDistanceMeters,
  latLonToVector,
  normalizeLon,
} from "../src/geo.ts";

test("haversine: 1 degree of latitude at equator", () => {
  const d = haversineDistanceMeters(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111195.08) < 1);
});

test("haversine: zero distance", () => {
  assert.equal(haversineDistanceMeters(31.2, 121.5, 31.2, 121.5), 0);
});

test("haversine: short path across the dateline", () => {
  const d = haversineDistanceMeters(0, 179.9, 0, -179.9);
  assert.ok(Math.abs(d - 22239.0) < 1);
});

test("haversine: lon 180 and -180 are the same meridian", () => {
  const d = haversineDistanceMeters(10, 180, 10, -180);
  assert.ok(d < 1e-6);
});

test("haversine: all longitudes coincide at a pole", () => {
  assert.ok(haversineDistanceMeters(90, 0, 90, 120) < 1e-6);
  assert.ok(haversineDistanceMeters(-90, -45, -90, 45) < 1e-6);
});

test("haversine: near-pole cross-longitude distance", () => {
  const d = haversineDistanceMeters(89.9, 0, 89.9, 180);
  assert.ok(Math.abs(d - 22239.0) < 1);
});

test("normalizeLon maps 180 to -180", () => {
  assert.equal(normalizeLon(180), -180);
  assert.equal(normalizeLon(-180), -180);
  assert.equal(normalizeLon(120.5), 120.5);
});

test("latLonToVector: pole is longitude-independent", () => {
  const a = latLonToVector(90, 0);
  const b = latLonToVector(90, 123);
  assert.ok(Math.abs(a.x - b.x) < 1e-12);
  assert.ok(Math.abs(a.y - b.y) < 1e-12);
  assert.ok(Math.abs(a.z - b.z) < 1e-12);
});
