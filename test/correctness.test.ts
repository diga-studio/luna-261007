import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttributionStore } from '../src/index.js';
import type { Dependency, Observation, OwnershipInterval, Severity } from '../src/index.js';

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // fixed base time (UTC ms)

function obs(
  id: string,
  srcIp: string,
  dstIp: string,
  ts: number,
  severity: Severity = 'standard',
): Observation {
  return { id, srcIp, dstIp, observedAtMs: ts, severity };
}

function depMap(deps: Dependency[]): Map<string, Dependency> {
  return new Map(deps.map((d) => [`${d.srcAsset}->${d.dstAsset}`, d]));
}

test('out-of-order and duplicate observations across an IP transfer boundary', () => {
  const store = new AttributionStore(':memory:');
  // ipA owned by assetX until T0+10h, then by assetY.
  store.reviseTimeline('ipA', [
    { startMs: T0, endMs: T0 + 10 * HOUR, assetId: 'assetX' },
    { startMs: T0 + 10 * HOUR, endMs: null, assetId: 'assetY' },
  ]);
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]);

  const boundary = T0 + 10 * HOUR;
  const batch = [
    obs('o-after', 'ipA', 'ipB', boundary, 'critical'), // first instant of assetY
    obs('o-before', 'ipA', 'ipB', boundary - 1, 'standard'), // last instant of assetX
    obs('o-dup', 'ipA', 'ipB', boundary - 2, 'informational'),
    obs('o-dup', 'ipA', 'ipB', boundary - 2, 'informational'), // exact duplicate
  ];
  const res = store.ingest(batch);
  assert.equal(res.accepted, 3);
  assert.equal(res.duplicates, 1);

  const now = boundary + 1;
  const edgeXY = store.getDependency('assetX', 'assetY', now);
  assert.equal(edgeXY, null); // no such pair in data
  const oldEdge = store.getDependency('assetX', 'assetZ', now);
  assert.ok(oldEdge);
  assert.equal(oldEdge.supportCount, 2);
  assert.equal(oldEdge.lastObservedAtMs, boundary - 1);
  assert.equal(oldEdge.severity, 'standard');
  const newEdge = store.getDependency('assetY', 'assetZ', now);
  assert.ok(newEdge);
  assert.equal(newEdge.supportCount, 1);
  assert.equal(newEdge.severity, 'critical');
  store.close();
});

test('filling an ownership gap retroactively creates dependencies', () => {
  const store = new AttributionStore(':memory:');
  // ipA has a gap [T0+5h, T0+15h)
  store.reviseTimeline('ipA', [
    { startMs: T0, endMs: T0 + 5 * HOUR, assetId: 'assetX' },
    { startMs: T0 + 15 * HOUR, endMs: null, assetId: 'assetX' },
  ]);
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]);

  store.ingest([obs('o-gap', 'ipA', 'ipB', T0 + 10 * HOUR, 'critical')]);
  assert.equal(store.getDependency('assetX', 'assetZ', T0 + 20 * HOUR), null);

  // Late registration fills the gap.
  store.reviseTimeline('ipA', [
    { startMs: T0, endMs: T0 + 5 * HOUR, assetId: 'assetX' },
    { startMs: T0 + 5 * HOUR, endMs: T0 + 15 * HOUR, assetId: 'assetX' },
    { startMs: T0 + 15 * HOUR, endMs: null, assetId: 'assetX' },
  ]);
  const edge = store.getDependency('assetX', 'assetZ', T0 + 20 * HOUR);
  assert.ok(edge);
  assert.equal(edge.supportCount, 1);
  assert.equal(edge.severity, 'critical');
  store.close();
});

test('same-asset connection forms no edge until ownership is split', () => {
  const store = new AttributionStore(':memory:');
  // Both IPs belong to assetX: no dependency may form.
  store.reviseTimeline('ipA', [{ startMs: T0, endMs: null, assetId: 'assetX' }]);
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetX' }]);
  store.ingest([obs('o1', 'ipA', 'ipB', T0 + HOUR, 'critical')]);
  assert.equal(store.getGraph(T0 + 2 * HOUR).length, 0);

  // Correction: ipB actually belonged to assetY from the start.
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetY' }]);
  const edge = store.getDependency('assetX', 'assetY', T0 + 2 * HOUR);
  assert.ok(edge);
  assert.equal(edge.supportCount, 1);
  assert.equal(edge.severity, 'critical');
  store.close();
});

test('moving the only critical observation downgrades the old edge', () => {
  const store = new AttributionStore(':memory:');
  store.reviseTimeline('ipA', [{ startMs: T0, endMs: null, assetId: 'assetX' }]);
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]);
  store.ingest([
    obs('o-crit', 'ipA', 'ipB', T0 + 3 * HOUR, 'critical'),
    obs('o-info', 'ipA', 'ipB', T0 + HOUR, 'informational'),
    obs('o-std', 'ipA', 'ipB', T0 + 2 * HOUR, 'standard'),
  ]);
  let edge = store.getDependency('assetX', 'assetZ', T0 + 4 * HOUR);
  assert.deepEqual(
    edge && { c: edge.supportCount, t: edge.lastObservedAtMs, s: edge.severity },
    { c: 3, t: T0 + 3 * HOUR, s: 'critical' },
  );

  // Correction: ipA belonged to assetY during [T0+2h, T0+4h): moves o-crit (and o-std? no, o-std at +2h is inclusive start).
  store.reviseTimeline('ipA', [
    { startMs: T0, endMs: T0 + 2 * HOUR, assetId: 'assetX' },
    { startMs: T0 + 2 * HOUR, endMs: T0 + 4 * HOUR, assetId: 'assetY' },
    { startMs: T0 + 4 * HOUR, endMs: null, assetId: 'assetX' },
  ]);
  edge = store.getDependency('assetX', 'assetZ', T0 + 4 * HOUR);
  assert.ok(edge);
  assert.equal(edge.supportCount, 1); // only o-info remains
  assert.equal(edge.severity, 'informational'); // downgraded
  assert.equal(edge.lastObservedAtMs, T0 + HOUR); // rolled back
  const moved = store.getDependency('assetY', 'assetZ', T0 + 4 * HOUR);
  assert.ok(moved);
  assert.equal(moved.supportCount, 2); // o-crit + o-std, counted exactly once
  assert.equal(moved.severity, 'critical');
  assert.equal(moved.lastObservedAtMs, T0 + 3 * HOUR);
  store.close();
});

test('removing the last observation deletes the old edge without touching others', () => {
  const store = new AttributionStore(':memory:');
  store.reviseTimeline('ipA', [{ startMs: T0, endMs: null, assetId: 'assetX' }]);
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]);
  store.reviseTimeline('ipC', [{ startMs: T0, endMs: null, assetId: 'assetW' }]);
  store.ingest([
    obs('o1', 'ipA', 'ipB', T0 + HOUR, 'critical'),
    obs('o2', 'ipA', 'ipC', T0 + HOUR, 'standard'),
  ]);

  // Reassign the whole early life of ipA to assetY: o1 moves away, o2 stays? o2 also at T0+HOUR.
  // Use a window covering only o1's timestamp to keep o2 on the old edge.
  store.reviseTimeline('ipA', [
    { startMs: T0, endMs: T0 + HOUR, assetId: 'assetX' },
    { startMs: T0 + HOUR, endMs: T0 + HOUR + 1, assetId: 'assetY' },
    { startMs: T0 + HOUR + 1, endMs: null, assetId: 'assetX' },
  ]);
  assert.equal(store.getDependency('assetX', 'assetZ', T0 + 2 * HOUR), null); // vanished
  assert.equal(store.getDependency('assetX', 'assetW', T0 + 2 * HOUR), null); // o2 moved too (same ts)
  const yToZ = store.getDependency('assetY', 'assetZ', T0 + 2 * HOUR);
  const yToW = store.getDependency('assetY', 'assetW', T0 + 2 * HOUR);
  assert.ok(yToZ && yToZ.supportCount === 1 && yToZ.severity === 'critical');
  assert.ok(yToW && yToW.supportCount === 1 && yToW.severity === 'standard');
  store.close();
});

test('shuffled ingest converges to the same graph as ordered ingest', () => {
  const timelines: Array<[string, OwnershipInterval[]]> = [
    ['ipA', [
      { startMs: T0, endMs: T0 + 10 * HOUR, assetId: 'assetX' },
      { startMs: T0 + 10 * HOUR, endMs: null, assetId: 'assetY' },
    ]],
    ['ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]],
    ['ipC', [{ startMs: T0, endMs: null, assetId: 'assetW' }]],
  ];
  const observations: Observation[] = [];
  const severities: Severity[] = ['critical', 'standard', 'informational'];
  for (let i = 0; i < 500; i++) {
    const ips = ['ipA', 'ipB', 'ipC'];
    const srcIp = ips[i % 3];
    const dstIp = ips[(i + 1) % 3];
    observations.push(
      obs(`o${i}`, srcIp, dstIp, T0 + (i % 97) * (HOUR / 4), severities[i % 3]),
    );
  }

  const build = (order: Observation[]): Map<string, Dependency> => {
    const store = new AttributionStore(':memory:');
    for (const [ip, tl] of timelines) store.reviseTimeline(ip, tl);
    store.ingest(order);
    const graph = depMap(store.getGraph(T0 + 200 * HOUR));
    store.close();
    return graph;
  };

  const ordered = build(observations);
  const shuffled = build([...observations].sort(() => 0.5 - Math.random()));
  assert.deepEqual(shuffled, ordered);
});

test('revision result equals a from-scratch rebuild over all raw observations', () => {
  const store = new AttributionStore(':memory:');
  store.reviseTimeline('ipA', [{ startMs: T0, endMs: null, assetId: 'assetX' }]);
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]);
  const all: Observation[] = [
    obs('o1', 'ipA', 'ipB', T0 + HOUR, 'critical'),
    obs('o2', 'ipA', 'ipB', T0 + 2 * HOUR, 'standard'),
    obs('o3', 'ipB', 'ipA', T0 + 3 * HOUR, 'informational'),
    obs('o4', 'ipA', 'ipB', T0 + 4 * HOUR, 'standard'),
  ];
  store.ingest(all);

  const finalTimeline: OwnershipInterval[] = [
    { startMs: T0, endMs: T0 + 2 * HOUR, assetId: 'assetX' },
    { startMs: T0 + 2 * HOUR, endMs: T0 + 3 * HOUR, assetId: 'assetY' },
    // gap [T0+3h, T0+4h)
    { startMs: T0 + 4 * HOUR, endMs: null, assetId: 'assetX' },
  ];
  store.reviseTimeline('ipA', finalTimeline);

  const rebuilt = new AttributionStore(':memory:');
  rebuilt.reviseTimeline('ipA', finalTimeline);
  rebuilt.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]);
  rebuilt.ingest(all);

  const now = T0 + 10 * HOUR;
  assert.deepEqual(depMap(store.getGraph(now)), depMap(rebuilt.getGraph(now)));
  store.close();
  rebuilt.close();
});

test('stale flag flips exactly at the 72-hour threshold', () => {
  const store = new AttributionStore(':memory:');
  store.reviseTimeline('ipA', [{ startMs: T0, endMs: null, assetId: 'assetX' }]);
  store.reviseTimeline('ipB', [{ startMs: T0, endMs: null, assetId: 'assetZ' }]);
  store.ingest([obs('o1', 'ipA', 'ipB', T0, 'standard')]);

  const last = T0;
  const justBefore = store.getDependency('assetX', 'assetZ', last + 72 * HOUR - 1);
  const exactly = store.getDependency('assetX', 'assetZ', last + 72 * HOUR);
  const after = store.getDependency('assetX', 'assetZ', last + 72 * HOUR + 1);
  assert.ok(justBefore && justBefore.stale === false);
  assert.ok(exactly && exactly.stale === true);
  assert.ok(after && after.stale === true);
  // Stale does not change support or severity.
  assert.equal(exactly.supportCount, 1);
  assert.equal(exactly.severity, 'standard');
  store.close();
});

test('overlapping timeline intervals are rejected', () => {
  const store = new AttributionStore(':memory:');
  assert.throws(() =>
    store.reviseTimeline('ipA', [
      { startMs: T0, endMs: T0 + 10 * HOUR, assetId: 'assetX' },
      { startMs: T0 + 5 * HOUR, endMs: null, assetId: 'assetY' },
    ]),
  );
  // Failed revision leaves previous state untouched.
  store.reviseTimeline('ipA', [{ startMs: T0, endMs: null, assetId: 'assetX' }]);
  assert.throws(() =>
    store.reviseTimeline('ipA', [
      { startMs: T0, endMs: T0 + HOUR, assetId: 'assetX' },
      { startMs: T0 + HOUR - 1, endMs: null, assetId: 'assetY' },
    ]),
  );
  store.close();
});
