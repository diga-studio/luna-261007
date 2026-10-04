import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSource,
  encodeTile,
  FeatureGeometry,
  InputFeature,
  TILE_SIZE,
} from '../src/index';
import { decodeMvt, DecodedFeature } from './decode';
import { netArea, pointInRings, ringIsSimple, signedArea2, Pt } from './helpers';

function mapRings(g: FeatureGeometry, fn: (ring: Pt[]) => Pt[]): FeatureGeometry {
  if (g.type === 'Polygon') {
    return { type: 'Polygon', coordinates: g.coordinates.map((r) => fn(r as Pt[])) };
  }
  return {
    type: 'MultiPolygon',
    coordinates: g.coordinates.map((poly) => poly.map((r) => fn(r as Pt[]))),
  };
}

function reverseRingDirections(f: InputFeature): InputFeature {
  return {
    id: f.id,
    geometry: mapRings(f.geometry, (ring) => ring.slice().reverse() as Pt[]),
  };
}

function rotateRingStarts(f: InputFeature, shift: number): InputFeature {
  return {
    id: f.id,
    geometry: mapRings(f.geometry, (ring) => {
      const k = ((shift % ring.length) + ring.length) % ring.length;
      return ring.slice(k).concat(ring.slice(0, k)) as Pt[];
    }),
  };
}

function onlyLayerFeature(bytes: Uint8Array): DecodedFeature[] {
  const layers = decodeMvt(bytes);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].version, 2);
  assert.equal(layers[0].extent, TILE_SIZE);
  return layers[0].features;
}

function splitRings(f: DecodedFeature): { outers: Pt[][]; holes: Pt[][] } {
  const outers: Pt[][] = [];
  const holes: Pt[][] = [];
  for (const ring of f.rings as Pt[][]) {
    const a = signedArea2(ring);
    assert.notEqual(a, 0, 'ring must have non-zero area');
    assert.ok(ringIsSimple(ring), 'ring must be simple');
    if (a > 0) outers.push(ring);
    else holes.push(ring);
  }
  return { outers, holes };
}

function assertSameCoverage(actual: Pt[][], expected: Pt[][], step: number): void {
  for (let y = 1; y < TILE_SIZE; y += step) {
    for (let x = 1; x < TILE_SIZE; x += step) {
      const a = pointInRings(actual, x, y);
      const e = pointInRings(expected, x, y);
      if (a !== e) {
        assert.fail(`coverage mismatch at (${x},${y}): decoded=${a} expected=${e}`);
      }
    }
  }
}

// A concave "C" shape whose connector lies left of the tile, so clipping
// splits it into two disjoint bars. One hole is fully inside the tile,
// another hole crosses the tile's left edge and becomes a notch.
const concaveFeature: InputFeature = {
  id: 1,
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-500, 100], [3000, 100], [3000, 200], [-100, 200],
        [-100, 400], [3000, 400], [3000, 500], [-500, 500],
      ],
      [[500, 120], [600, 120], [600, 180], [500, 180]],
      [[-200, 420], [800, 420], [800, 480], [-200, 480]],
    ],
  },
};
// bar1: 3000*100 - 100*60 (hole) = 294000
// bar2: 3000*100 - 800*60 (notch) = 252000
const CONCAVE_AREA = 294000 + 252000;

// Outer ring entirely outside the tile but covering it, with an inner hole.
const tileCoverFeature: InputFeature = {
  id: 2,
  geometry: {
    type: 'Polygon',
    coordinates: [
      [[-10000, -10000], [10000, -10000], [10000, 10000], [-10000, 10000]],
      [[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]],
    ],
  },
};
const COVER_AREA = TILE_SIZE * TILE_SIZE - 1000 * 1000;

test('concave polygon splits into fragments kept in one feature; holes preserved or cut open', () => {
  const source = createSource([concaveFeature, tileCoverFeature]);
  const features = onlyLayerFeature(encodeTile(source, 0, 0));
  assert.equal(features.length, 2);

  const frag = features.filter((f) => f.id === 1);
  assert.equal(frag.length, 1, 'all fragments stay in a single feature');
  const f1 = frag[0];
  assert.equal(f1.type, 3, 'MVT polygon type');
  const s1 = splitRings(f1);
  assert.equal(s1.outers.length, 2, 'two disjoint bars');
  assert.equal(s1.holes.length, 1, 'only the fully-inside hole survives as a hole');
  assert.equal(netArea(f1.rings as Pt[][]), CONCAVE_AREA);
  assertSameCoverage(
    f1.rings as Pt[][],
    (concaveFeature.geometry as { coordinates: Pt[][] }).coordinates,
    32,
  );

  const cover = features.filter((f) => f.id === 2);
  assert.equal(cover.length, 1);
  const s2 = splitRings(cover[0]);
  assert.equal(s2.outers.length, 1, 'tile-filling outer ring');
  assert.equal(s2.holes.length, 1, 'inner hole preserved');
  assert.equal(netArea(cover[0].rings as Pt[][]), COVER_AREA);
  assertSameCoverage(
    cover[0].rings as Pt[][],
    (tileCoverFeature.geometry as { coordinates: Pt[][] }).coordinates,
    64,
  );

  // Spot-check membership of the decoded feature 1.
  const rings1 = f1.rings as Pt[][];
  assert.equal(pointInRings(rings1, 100, 150), true, 'bar1 body');
  assert.equal(pointInRings(rings1, 550, 150), false, 'inside kept hole');
  assert.equal(pointInRings(rings1, 100, 300), false, 'gap between bars');
  assert.equal(pointInRings(rings1, 400, 450), false, 'notch cut by tile edge');
  assert.equal(pointInRings(rings1, 900, 450), true, 'bar2 body');
  assert.equal(pointInRings(rings1, 3500, 150), false, 'beyond polygon');
});

test('edge-coincident, corner-touch and line-only intersections', () => {
  const features: InputFeature[] = [
    {
      id: 10, // edges exactly on the tile boundary
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [2000, 0], [2000, 2000], [0, 2000]]] },
    },
    {
      id: 11, // touches the tile only at corner point (0,0)
      geometry: { type: 'Polygon', coordinates: [[[-1000, -1000], [0, -1000], [0, 0], [-1000, 0]]] },
    },
    {
      id: 12, // shares only the segment x=0 with the tile
      geometry: { type: 'Polygon', coordinates: [[[-1000, 500], [0, 500], [0, 1500], [-1000, 1500]]] },
    },
    {
      id: 13, // shares only the segment y=0 with the tile
      geometry: { type: 'Polygon', coordinates: [[[-500, -1000], [500, -1000], [500, 0], [-500, 0]]] },
    },
    {
      id: 14, // fully outside
      geometry: { type: 'Polygon', coordinates: [[[5000, 5000], [6000, 5000], [6000, 6000], [5000, 6000]]] },
    },
    {
      id: 15, // shares only the segment x=4096 with the tile
      geometry: { type: 'Polygon', coordinates: [[[4096, 0], [8192, 0], [8192, 4096], [4096, 4096]]] },
    },
    {
      id: 16, // MultiPolygon: two disjoint squares in one feature
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[100, 100], [500, 100], [500, 500], [100, 500]]],
          [[[2000, 2000], [2400, 2000], [2400, 2400], [2000, 2400]]],
        ],
      },
    },
  ];
  const decoded = onlyLayerFeature(encodeTile(createSource(features), 0, 0));
  const ids = decoded.map((f) => f.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [10, 16], 'zero-area intersections are dropped');

  const f10 = decoded.find((f) => f.id === 10)!;
  const s10 = splitRings(f10);
  assert.equal(s10.outers.length, 1);
  assert.equal(s10.holes.length, 0);
  assert.equal(netArea(f10.rings as Pt[][]), 2000 * 2000);

  const f16 = decoded.find((f) => f.id === 16)!;
  const s16 = splitRings(f16);
  assert.equal(s16.outers.length, 2, 'both squares in one feature');
  assert.equal(netArea(f16.rings as Pt[][]), 400 * 400 * 2);
});

test('ring direction reversal and start-point rotation keep coverage identical', () => {
  const variants = [
    concaveFeature,
    reverseRingDirections(concaveFeature),
    rotateRingStarts(concaveFeature, 3),
    reverseRingDirections(rotateRingStarts(concaveFeature, 5)),
  ];
  const encoded = variants.map((v) => encodeTile(createSource([v, tileCoverFeature]), 0, 0));
  for (let i = 1; i < encoded.length; i++) {
    assert.deepEqual(
      Array.from(encoded[i]),
      Array.from(encoded[0]),
      `variant ${i} must encode identically`,
    );
  }
  const features = onlyLayerFeature(encoded[0]);
  const f1 = features.find((f) => f.id === 1)!;
  assert.equal(netArea(f1.rings as Pt[][]), CONCAVE_AREA);
});

test('faces touching at a single point are not merged into a self-intersecting ring', () => {
  const features: InputFeature[] = [
    {
      id: 20,
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]] },
    },
    {
      id: 21, // touches feature 20 only at the point (1000,1000)
      geometry: {
        type: 'Polygon',
        coordinates: [[[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]]],
      },
    },
  ];
  const decoded = onlyLayerFeature(encodeTile(createSource(features), 0, 0));
  assert.equal(decoded.length, 2, 'touching faces stay separate features');
  for (const f of decoded) {
    const s = splitRings(f); // also asserts simplicity and non-zero area
    assert.equal(s.outers.length, 1);
    assert.equal(s.outers[0].length, 4, 'plain square ring, no figure-eight');
    assert.equal(netArea(f.rings as Pt[][]), 1000 * 1000);
  }
});

test('non-zero tile coordinates use the correct global origin', () => {
  // Same shape as the concave feature, shifted two tiles right and one down.
  const dx = 2 * TILE_SIZE;
  const dy = TILE_SIZE;
  const shifted: InputFeature = {
    id: 7,
    geometry: mapRings(concaveFeature.geometry, (ring) =>
      ring.map(([x, y]) => [x + dx, y + dy] as Pt),
    ) as FeatureGeometry,
  };
  const decoded = onlyLayerFeature(encodeTile(createSource([shifted]), 2, 1));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].id, 7);
  const s = splitRings(decoded[0]);
  assert.equal(s.outers.length, 2);
  assert.equal(s.holes.length, 1);
  assert.equal(netArea(decoded[0].rings as Pt[][]), CONCAVE_AREA);
  const expected = (concaveFeature.geometry as { coordinates: Pt[][] }).coordinates;
  assertSameCoverage(decoded[0].rings as Pt[][], expected, 32);
});
