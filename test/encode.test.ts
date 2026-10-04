import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSource, encodeTile, TILE_EXTENT } from '../src/index.ts';
import type { AreaFeature, Ring } from '../src/index.ts';
import {
  decodeTile,
  coveredArea,
  coversPoint,
  isSimpleRing,
  signedArea2,
  type DecodedFeature,
} from '../helpers/decode.ts';

const P = (x: number, y: number): [number, number] => [x, y];

/** Concave "arch" polygon: two legs inside the tile joined by a bar that lies
 * entirely above the tile, so clipping splits it into two disjoint regions.
 * holeA is fully kept; holeB crosses the tile's top edge and becomes a notch. */
const archOuter: Ring = [
  P(500, 3500), P(500, -1000), P(3500, -1000), P(3500, 3500),
  P(2500, 3500), P(2500, -100), P(1500, -100), P(1500, 3500),
  P(500, 3500),
];
const holeA: Ring = [P(700, 1000), P(1300, 1000), P(1300, 2000), P(700, 2000), P(700, 1000)];
const holeB: Ring = [P(2700, -500), P(3300, -500), P(3300, 1000), P(2700, 1000), P(2700, -500)];

const archFeature: AreaFeature = {
  id: 1,
  geometry: { type: 'Polygon', coordinates: [archOuter, holeA, holeB] },
};

/** Outer ring entirely outside the tile but covering it completely. */
const coverAllFeature: AreaFeature = {
  id: 2,
  geometry: {
    type: 'Polygon',
    coordinates: [[P(-1000, -1000), P(5000, -1000), P(5000, 5000), P(-1000, 5000), P(-1000, -1000)]],
  },
};

function onlyFeature(id: number, bytes: Uint8Array): DecodedFeature {
  const layers = decodeTile(bytes);
  assert.equal(layers.length, 1);
  assert.equal(layers[0]!.version, '2');
  assert.equal(layers[0]!.extent, TILE_EXTENT);
  const found = layers[0]!.features.filter((f) => f.id === id);
  assert.equal(found.length, 1, `expected exactly one feature with id ${id}`);
  return found[0]!;
}

test('concave polygon split by clip keeps fragments in one feature, holes preserved or notched', () => {
  const source = createSource([archFeature, coverAllFeature]);
  const layers = decodeTile(encodeTile(source, 0, 0));
  assert.equal(layers.length, 1);
  const layer = layers[0]!;
  assert.equal(layer.features.length, 2, 'both features intersect the tile with area');

  const arch = onlyFeature(1, encodeTile(source, 0, 0));
  assert.equal(arch.type, 3, 'MVT geometry type POLYGON');

  // Two disjoint legs -> two exterior rings; kept hole -> one interior ring.
  const exteriors = arch.rings.filter((r) => signedArea2(r) > 0);
  const holes = arch.rings.filter((r) => signedArea2(r) < 0);
  assert.equal(exteriors.length, 2, 'clipped arch splits into two exterior rings');
  assert.equal(holes.length, 1, 'only the fully kept hole survives as a hole');
  assert.equal(signedArea2(holes[0]!) / 2, -600_000, 'kept hole area 600x1000');

  // leg1: 1000*3500 - holeA(600*1000); leg2: 1000*3500 - notch(600*1000)
  assert.equal(coveredArea(arch), 2 * (1_000 * 3_500 - 600 * 1_000));

  for (const ring of arch.rings) {
    assert.ok(isSimpleRing(ring), 'every output ring is simple');
    assert.notEqual(signedArea2(ring), 0, 'every output ring has non-zero area');
  }

  const inside: [number, number][] = [
    [1_000, 2_500], // leg 1
    [3_000, 2_000], // leg 2, below the notch
    [600, 100], // leg 1 near the top edge
  ];
  const outside: [number, number][] = [
    [1_000, 1_500], // inside kept hole A
    [3_000, 500], // inside the notch left by hole B
    [2_000, 1_000], // gap between the legs
    [1_000, 4_000], // below the legs
    [100, 100], // outside the polygon
  ];
  for (const [x, y] of inside) assert.ok(coversPoint(arch, x, y), `(${x},${y}) covered`);
  for (const [x, y] of outside) assert.ok(!coversPoint(arch, x, y), `(${x},${y}) not covered`);

  // Feature whose outer ring lies fully outside the tile covers it entirely.
  const coverAll = onlyFeature(2, encodeTile(source, 0, 0));
  assert.equal(coverAll.rings.length, 1);
  assert.equal(coveredArea(coverAll), TILE_EXTENT * TILE_EXTENT);
  assert.ok(coversPoint(coverAll, 2048, 2048));

  // The neighboring tile to the left contains only the cover-all feature.
  const leftLayer = decodeTile(encodeTile(source, -1, 0))[0]!;
  assert.deepEqual(leftLayer.features.map((f) => f.id), [2]);
});

test('arch on a tile that contains nothing of it yields no feature', () => {
  const source = createSource([archFeature]);
  const layers = decodeTile(encodeTile(source, 5, 5));
  assert.equal(layers[0]!.features.length, 0);
});

function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)];
}

test('edge-coincident intersection kept; point-only and line-only intersections dropped', () => {
  const features: AreaFeature[] = [
    { id: 10, geometry: { type: 'Polygon', coordinates: [rect(0, 0, 1000, 1000)] } },
    { id: 11, geometry: { type: 'Polygon', coordinates: [rect(-1000, -1000, 0, 0)] } },
    { id: 12, geometry: { type: 'Polygon', coordinates: [rect(4096, 4096, 5000, 5000)] } },
    { id: 13, geometry: { type: 'Polygon', coordinates: [rect(-500, 1000, 0, 2000)] } },
    { id: 14, geometry: { type: 'Polygon', coordinates: [rect(4096, 1000, 5000, 2000)] } },
    { id: 15, geometry: { type: 'Polygon', coordinates: [rect(2000, -500, 3000, 0)] } },
  ];
  const layer = decodeTile(encodeTile(createSource(features), 0, 0))[0]!;
  const ids = layer.features.map((f) => f.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [10], 'only the area intersection survives');
  const kept = layer.features[0]!;
  assert.equal(coveredArea(kept), 1_000_000);
  assert.equal(kept.rings.length, 1);
  assert.ok(isSimpleRing(kept.rings[0]!));
});

function reverseRing(ring: Ring): Ring {
  return [...ring].reverse();
}

function rotateRing(ring: Ring, k: number): Ring {
  const open = ring.slice(0, -1);
  const n = open.length;
  const rotated = open.map((_, i) => open[(i + k) % n]!);
  return [...rotated, rotated[0]!];
}

function mapGeometry(feature: AreaFeature, fn: (ring: Ring) => Ring): AreaFeature {
  const g = feature.geometry;
  const coordinates =
    g.type === 'Polygon'
      ? [g.coordinates.map(fn)]
      : g.coordinates.map((poly) => poly.map(fn));
  return { id: feature.id, geometry: { type: 'MultiPolygon', coordinates } };
}

test('ring orientation and start point do not change the covered region', () => {
  const original = archFeature;
  const reversed = mapGeometry(original, reverseRing);
  const rotated = mapGeometry(original, (r) => rotateRing(r, 3));

  const decode = (f: AreaFeature): DecodedFeature =>
    onlyFeature(f.id, encodeTile(createSource([f]), 0, 0));
  const a = decode(original);
  const b = decode(reversed);
  const c = decode(rotated);

  assert.equal(coveredArea(a), coveredArea(b));
  assert.equal(coveredArea(a), coveredArea(c));
  assert.equal(a.rings.length, b.rings.length);
  assert.equal(a.rings.length, c.rings.length);

  for (let y = 128; y < TILE_EXTENT; y += 256) {
    for (let x = 128; x < TILE_EXTENT; x += 256) {
      assert.equal(coversPoint(b, x, y), coversPoint(a, x, y), `reversed differs at ${x},${y}`);
      assert.equal(coversPoint(c, x, y), coversPoint(a, x, y), `rotated differs at ${x},${y}`);
    }
  }
});

test('parts touching at a single point after clipping stay separate simple rings', () => {
  const feature: AreaFeature = {
    id: 20,
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [rect(1000, 1000, 2000, 2000)],
        // extends past the tile edge; after clipping it touches square 1 only
        // at the single point (2000, 2000)
        [rect(2000, 2000, 5000, 3000)],
      ],
    },
  };
  const decoded = onlyFeature(20, encodeTile(createSource([feature]), 0, 0));
  assert.equal(decoded.rings.length, 2, 'point-touching parts are not merged into one ring');
  for (const ring of decoded.rings) {
    assert.ok(isSimpleRing(ring), 'ring must not pass through the touch point twice');
    assert.ok(signedArea2(ring) > 0, 'both rings are exterior');
  }
  assert.equal(coveredArea(decoded), 1_000_000 + 2096 * 1000);
  assert.ok(coversPoint(decoded, 1500, 1500));
  assert.ok(coversPoint(decoded, 2500, 2500));
  assert.ok(!coversPoint(decoded, 2500, 1500));
  assert.ok(!coversPoint(decoded, 1500, 2500));
});
