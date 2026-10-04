import { equal, ok } from 'node:assert/strict';
import test from 'node:test';
import { STALE_THRESHOLD_MS, type Observation } from '../src/index.js';
import { assertGraphEquals, freshStore, referenceGraph } from './helpers.js';

const T0 = 1_700_000_000_000; // fixed base time, UTC ms

function obs(partial: Partial<Observation> & { id: string }): Observation {
  return {
    srcIp: '10.0.0.1',
    dstIp: '10.0.0.2',
    observedAtMs: T0,
    severity: 'standard',
    ...partial,
  };
}

test('directed edges merge; reverse direction is a separate dependency', () => {
  const { store, cleanup } = freshStore();
  try {
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 1000, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 1000, assetId: 'B' }]);
    store.ingest([
      obs({ id: 'o1', observedAtMs: T0 }),
      obs({ id: 'o2', observedAtMs: T0 + 100, severity: 'critical' }),
      obs({ id: 'o3', srcIp: '10.0.0.2', dstIp: '10.0.0.1', observedAtMs: T0 + 50 }),
    ]);
    const ab = store.getDependency('A', 'B', T0 + 100);
    ok(ab !== null);
    equal(ab.supportCount, 2);
    equal(ab.lastObservedAtMs, T0 + 100);
    equal(ab.severity, 'critical');
    const ba = store.getDependency('B', 'A', T0 + 100);
    ok(ba !== null);
    equal(ba.supportCount, 1);
    equal(ba.severity, 'standard');
  } finally {
    cleanup();
  }
});

test('out-of-order and duplicate observations at an IP transfer boundary', () => {
  const { store, cleanup } = freshStore();
  try {
    // IP moves from asset A to asset C at T0+1000: [0,T0+1000) -> A, [T0+1000,..) -> C
    store.reviseOwnership('10.0.0.1', [
      { startMs: 0, endMs: T0 + 1000, assetId: 'A' },
      { startMs: T0 + 1000, endMs: T0 + 5000, assetId: 'C' },
    ]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
    // Delivered out of order; o1 duplicated.
    const batch = [
      obs({ id: 'o3', observedAtMs: T0 + 1000 }), // first ms owned by C
      obs({ id: 'o1', observedAtMs: T0 + 999 }), // last ms owned by A
      obs({ id: 'o2', observedAtMs: T0, severity: 'critical' }),
      obs({ id: 'o1', observedAtMs: T0 + 999 }), // duplicate
    ];
    const result = store.ingest(batch);
    equal(result.inserted, 3);
    equal(result.duplicates, 1);

    const ab = store.getDependency('A', 'B', T0 + 2000);
    ok(ab !== null);
    equal(ab.supportCount, 2);
    equal(ab.lastObservedAtMs, T0 + 999);
    equal(ab.severity, 'critical');
    const cb = store.getDependency('C', 'B', T0 + 2000);
    ok(cb !== null);
    equal(cb.supportCount, 1);
    equal(cb.lastObservedAtMs, T0 + 1000);

    // Same final graph as in-order ingest without duplicates.
    const { store: store2, cleanup: cleanup2 } = freshStore();
    try {
      store2.reviseOwnership('10.0.0.1', [
        { startMs: 0, endMs: T0 + 1000, assetId: 'A' },
        { startMs: T0 + 1000, endMs: T0 + 5000, assetId: 'C' },
      ]);
      store2.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
      store2.ingest([
        obs({ id: 'o2', observedAtMs: T0, severity: 'critical' }),
        obs({ id: 'o1', observedAtMs: T0 + 999 }),
        obs({ id: 'o3', observedAtMs: T0 + 1000 }),
      ]);
      assertGraphEquals(store.getGraph(T0 + 2000), store2.getGraph(T0 + 2000));
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

test('observations in ownership gaps or same-asset form no dependency but are kept', () => {
  const { store, cleanup } = freshStore();
  try {
    // 10.0.0.1 has a gap [T0, T0+1000); 10.0.0.3 owned by A (same as 10.0.0.1).
    store.reviseOwnership('10.0.0.1', [
      { startMs: 0, endMs: T0, assetId: 'A' },
      { startMs: T0 + 1000, endMs: T0 + 2000, assetId: 'A' },
    ]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 2000, assetId: 'B' }]);
    store.reviseOwnership('10.0.0.3', [{ startMs: 0, endMs: T0 + 2000, assetId: 'A' }]);
    store.ingest([
      obs({ id: 'gap', observedAtMs: T0 + 500 }), // src in gap
      obs({ id: 'same', dstIp: '10.0.0.3', observedAtMs: T0 + 1500 }), // A -> A
      obs({ id: 'real', observedAtMs: T0 + 1500 }),
    ]);
    const graph = store.getGraph(T0 + 2000);
    equal(graph.length, 1);
    equal(graph[0]!.srcAssetId, 'A');
    equal(graph[0]!.dstAssetId, 'B');
    equal(graph[0]!.supportCount, 1);
  } finally {
    cleanup();
  }
});

test('stale flips exactly at 72 hours and never deletes the dependency', () => {
  const { store, cleanup } = freshStore();
  try {
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 1, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 1, assetId: 'B' }]);
    store.ingest([obs({ id: 'o1', observedAtMs: T0, severity: 'critical' })]);

    const fresh = store.getDependency('A', 'B', T0 + STALE_THRESHOLD_MS - 1);
    ok(fresh !== null);
    equal(fresh.stale, false);

    const exactly = store.getDependency('A', 'B', T0 + STALE_THRESHOLD_MS);
    ok(exactly !== null);
    equal(exactly.stale, true);
    equal(exactly.supportCount, 1);
    equal(exactly.severity, 'critical');

    const later = store.getDependency('A', 'B', T0 + STALE_THRESHOLD_MS * 10);
    ok(later !== null);
    equal(later.stale, true);
    equal(later.supportCount, 1);
  } finally {
    cleanup();
  }
});

test('ingest matches the independent reference recomputation', () => {
  const { store, cleanup } = freshStore();
  try {
    const timelines = new Map([
      ['10.0.0.1', [{ startMs: 0, endMs: T0 + 500, assetId: 'A' }]],
      ['10.0.0.2', [{ startMs: 0, endMs: T0 + 500, assetId: 'B' }]],
      ['10.0.0.3', [{ startMs: 0, endMs: T0 + 500, assetId: 'C' }]],
    ] as const);
    for (const [ip, intervals] of timelines) {
      store.reviseOwnership(ip, intervals);
    }
    const observations: Observation[] = [
      obs({ id: 'a', dstIp: '10.0.0.2', observedAtMs: T0 + 1 }),
      obs({ id: 'b', dstIp: '10.0.0.3', observedAtMs: T0 + 2, severity: 'critical' }),
      obs({ id: 'c', srcIp: '10.0.0.2', dstIp: '10.0.0.3', observedAtMs: T0 + 3 }),
      obs({ id: 'a', dstIp: '10.0.0.2', observedAtMs: T0 + 1 }), // dup
      obs({ id: 'd', dstIp: '10.0.0.9', observedAtMs: T0 + 4 }), // unknown ip
    ];
    store.ingest(observations);
    assertGraphEquals(store.getGraph(T0 + 1000), referenceGraph(timelines, observations, T0 + 1000));
  } finally {
    cleanup();
  }
});
