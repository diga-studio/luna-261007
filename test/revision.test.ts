import { equal, ok } from 'node:assert/strict';
import test from 'node:test';
import type { Observation, OwnershipInterval } from '../src/index.js';
import { assertGraphEquals, freshStore, referenceGraph } from './helpers.js';

const T0 = 1_700_000_000_000;

function obs(partial: Partial<Observation> & { id: string }): Observation {
  return {
    srcIp: '10.0.0.1',
    dstIp: '10.0.0.2',
    observedAtMs: T0,
    severity: 'standard',
    ...partial,
  };
}

test('backfilling an ownership gap regenerates dependencies; equals in-order import', () => {
  const { store, cleanup } = freshStore();
  try {
    // Initially 10.0.0.1 has a gap covering [T0, T0+2000).
    store.reviseOwnership('10.0.0.1', [{ startMs: T0 + 2000, endMs: T0 + 5000, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
    const observations = [
      obs({ id: 'late1', observedAtMs: T0 + 500, severity: 'critical' }),
      obs({ id: 'late2', observedAtMs: T0 + 1500 }),
      obs({ id: 'normal', observedAtMs: T0 + 2500 }),
    ];
    store.ingest(observations);
    // Gap observations form no dependency yet.
    equal(store.getDependency('A', 'B', T0 + 3000)!.supportCount, 1);

    // Registration arrives late: backfill the gap.
    const result = store.reviseOwnership('10.0.0.1', [
      { startMs: 0, endMs: T0 + 5000, assetId: 'A' },
    ]);
    equal(result.reattributed, 2);
    const ab = store.getDependency('A', 'B', T0 + 3000);
    ok(ab !== null);
    equal(ab.supportCount, 3);
    equal(ab.lastObservedAtMs, T0 + 2500);
    equal(ab.severity, 'critical');

    // Identical to a store that knew the full timeline from the start.
    const { store: store2, cleanup: cleanup2 } = freshStore();
    try {
      store2.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 5000, assetId: 'A' }]);
      store2.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
      store2.ingest(observations);
      assertGraphEquals(store.getGraph(T0 + 3000), store2.getGraph(T0 + 3000));
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

test('moving the only critical observation downgrades the old edge; new edge exact', () => {
  const { store, cleanup } = freshStore();
  try {
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 5000, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
    store.reviseOwnership('10.0.0.9', [{ startMs: 0, endMs: T0 + 5000, assetId: 'C' }]);
    store.ingest([
      obs({ id: 'crit', observedAtMs: T0 + 100, severity: 'critical' }),
      obs({ id: 'std1', observedAtMs: T0 + 200 }),
      obs({ id: 'info', observedAtMs: T0 + 300, severity: 'informational' }),
    ]);
    equal(store.getDependency('A', 'B', T0 + 1000)!.severity, 'critical');

    // Correction: during [T0+50, T0+150) the IP actually belonged to C.
    store.reviseOwnership('10.0.0.1', [
      { startMs: 0, endMs: T0 + 50, assetId: 'A' },
      { startMs: T0 + 50, endMs: T0 + 150, assetId: 'C' },
      { startMs: T0 + 150, endMs: T0 + 5000, assetId: 'A' },
    ]);
    const ab = store.getDependency('A', 'B', T0 + 1000);
    ok(ab !== null);
    equal(ab.supportCount, 2);
    equal(ab.severity, 'standard'); // downgraded
    equal(ab.lastObservedAtMs, T0 + 300);
    const cb = store.getDependency('C', 'B', T0 + 1000);
    ok(cb !== null);
    equal(cb.supportCount, 1); // not over-counted
    equal(cb.severity, 'critical');
    equal(cb.lastObservedAtMs, T0 + 100);
  } finally {
    cleanup();
  }
});

test('moving the latest observation rolls back lastObservedAtMs; moving all removes edge', () => {
  const { store, cleanup } = freshStore();
  try {
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 5000, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
    store.reviseOwnership('10.0.0.9', [{ startMs: 0, endMs: T0 + 5000, assetId: 'C' }]);
    store.ingest([
      obs({ id: 'old', observedAtMs: T0 + 100 }),
      obs({ id: 'latest', observedAtMs: T0 + 900, severity: 'critical' }),
    ]);

    // Move only the latest observation to C.
    store.reviseOwnership('10.0.0.1', [
      { startMs: 0, endMs: T0 + 500, assetId: 'A' },
      { startMs: T0 + 500, endMs: T0 + 5000, assetId: 'C' },
    ]);
    const ab = store.getDependency('A', 'B', T0 + 1000);
    ok(ab !== null);
    equal(ab.supportCount, 1);
    equal(ab.lastObservedAtMs, T0 + 100); // rolled back
    equal(ab.severity, 'standard'); // critical left with the moved observation

    // Move the remaining observation too: the A->B edge must disappear.
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 5000, assetId: 'C' }]);
    equal(store.getDependency('A', 'B', T0 + 1000), null);
    const cb = store.getDependency('C', 'B', T0 + 1000);
    ok(cb !== null);
    equal(cb.supportCount, 2);
    equal(cb.severity, 'critical');
    equal(cb.lastObservedAtMs, T0 + 900);
  } finally {
    cleanup();
  }
});

test('splitting a same-asset connection creates the missing dependency', () => {
  const { store, cleanup } = freshStore();
  try {
    // Both IPs registered to the same asset A: no dependency forms.
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 5000, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'A' }]);
    store.ingest([
      obs({ id: 'o1', observedAtMs: T0 + 100 }),
      obs({ id: 'o2', observedAtMs: T0 + 200, severity: 'critical' }),
    ]);
    equal(store.getGraph(T0 + 1000).length, 0);

    // Correction: 10.0.0.2 belonged to B all along.
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
    const ab = store.getDependency('A', 'B', T0 + 1000);
    ok(ab !== null);
    equal(ab.supportCount, 2);
    equal(ab.severity, 'critical');
    equal(ab.lastObservedAtMs, T0 + 200);
  } finally {
    cleanup();
  }
});

test('revision keeps edges still supported by untouched observations (no ghosts, no losses)', () => {
  const { store, cleanup } = freshStore();
  try {
    // Two IPs on asset A talk to B; only one IP's timeline is revised.
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 5000, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.2', [{ startMs: 0, endMs: T0 + 5000, assetId: 'B' }]);
    store.reviseOwnership('10.0.0.3', [{ startMs: 0, endMs: T0 + 5000, assetId: 'A' }]);
    store.reviseOwnership('10.0.0.9', [{ startMs: 0, endMs: T0 + 5000, assetId: 'C' }]);
    store.ingest([
      obs({ id: 'via1', observedAtMs: T0 + 100, severity: 'critical' }),
      obs({ id: 'via3', srcIp: '10.0.0.3', observedAtMs: T0 + 200 }),
    ]);
    equal(store.getDependency('A', 'B', T0 + 1000)!.supportCount, 2);

    // 10.0.0.1 moves to C entirely; 10.0.0.3 still supports A->B.
    store.reviseOwnership('10.0.0.1', [{ startMs: 0, endMs: T0 + 5000, assetId: 'C' }]);
    const ab = store.getDependency('A', 'B', T0 + 1000);
    ok(ab !== null);
    equal(ab.supportCount, 1);
    equal(ab.severity, 'standard'); // critical left with via1
    equal(ab.lastObservedAtMs, T0 + 200);
    const cb = store.getDependency('C', 'B', T0 + 1000);
    ok(cb !== null);
    equal(cb.supportCount, 1);
    equal(cb.severity, 'critical');
  } finally {
    cleanup();
  }
});

test('randomized revisions always match independent full recomputation', () => {
  const { store, cleanup } = freshStore();
  try {
    // Deterministic pseudo-random generator.
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'];
    const assets = ['A', 'B', 'C', 'D'];
    const timelines = new Map<string, OwnershipInterval[]>();
    const randomTimeline = (): OwnershipInterval[] => {
      const intervals: OwnershipInterval[] = [];
      let cursor = 0;
      const segments = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < segments; i += 1) {
        cursor += Math.floor(rand() * 2000); // possible gap
        const length = 1 + Math.floor(rand() * 3000);
        intervals.push({
          startMs: cursor,
          endMs: cursor + length,
          assetId: assets[Math.floor(rand() * assets.length)]!,
        });
        cursor += length;
      }
      return intervals;
    };
    for (const ip of ips) {
      const timeline = randomTimeline();
      timelines.set(ip, timeline);
      store.reviseOwnership(ip, timeline);
    }
    const observations: Observation[] = [];
    for (let i = 0; i < 500; i += 1) {
      observations.push({
        id: `obs-${i}`,
        srcIp: ips[Math.floor(rand() * ips.length)]!,
        dstIp: ips[Math.floor(rand() * ips.length)]!,
        observedAtMs: Math.floor(rand() * 12000),
        severity: (['informational', 'standard', 'critical'] as const)[
          Math.floor(rand() * 3)
        ]!,
      });
    }
    // Shuffle ingest order and duplicate some observations.
    const shuffled = [...observations].sort(() => rand() - 0.5);
    shuffled.push(...shuffled.slice(0, 50));
    store.ingest(shuffled);

    const nowMs = 20000;
    assertGraphEquals(store.getGraph(nowMs), referenceGraph(timelines, observations, nowMs));

    // Apply 30 random revisions; after each, compare against full recompute.
    for (let round = 0; round < 30; round += 1) {
      const ip = ips[Math.floor(rand() * ips.length)]!;
      const timeline = randomTimeline();
      timelines.set(ip, timeline);
      store.reviseOwnership(ip, timeline);
      assertGraphEquals(
        store.getGraph(nowMs),
        referenceGraph(timelines, observations, nowMs),
      );
    }
  } finally {
    cleanup();
  }
});
