import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrimStack, readArchive, CrashHook, MetricInput, RETENTION_HOURS, HOT_HOURS } from '../src/index.js';
import { RefModel, assertStatsEqual, tmpDir, DAY } from './helpers.js';

const T0 = 10_000_000;

function crashAt(point: string, armed = { count: 1 }): CrashHook {
  return (p) => {
    if (p === point && armed.count > 0) {
      armed.count -= 1;
      throw new Error(`simulated crash at ${point}`);
    }
  };
}

function reopen(dir: string, crashHook?: CrashHook): TrimStack {
  return TrimStack.open({ dir, crashHook });
}

/** Full-state comparison: every resource, whole retained range. */
function assertStateMatches(ts: TrimStack, ref: RefModel, resources: string[]): void {
  for (const r of resources) {
    assertStatsEqual(ts.query(r, 0, ref.t + 2 * RETENTION_HOURS), ref.query(r, 0, ref.t + 2 * RETENTION_HOURS));
  }
}

function seedBatches(): MetricInput[][] {
  // hours spread across what will become hot, cold and expired zones
  return [
    [
      { resource: 'r1', hour: T0 - 5 * DAY, revision: 1, utilization: 100 },
      { resource: 'r1', hour: T0 - 35 * DAY, revision: 1, utilization: 200 },
      { resource: 'r1', hour: T0 - 55 * DAY, revision: 1, utilization: 300 },
      { resource: 'r2', hour: T0 - 35 * DAY, revision: 1, utilization: 400 },
      { resource: 'r2', hour: T0 - 89 * DAY, revision: 1, utilization: 500 },
    ],
    [
      { resource: 'r1', hour: T0 - 35 * DAY, revision: 2, utilization: 250 }, // cold correction
      { resource: 'r2', hour: T0 - 10 * DAY, revision: 1, utilization: 450 },
    ],
  ];
}

const MAINTAIN_POINTS = [
  'maintain.filesWritten',
  'maintain.inTransaction',
  'maintain.committed',
  'maintain.swept',
];

// Points that additionally require committed file deletions to exist.
const MAINTAIN_POINTS_WITH_SWEEP = [...MAINTAIN_POINTS, 'maintain.sweepFile'];

test('crash during first archival: unconfirmed maintain is fully applied or fully absent', () => {
  for (const point of MAINTAIN_POINTS) {
    const dir = tmpDir();
    const refBefore = new RefModel(T0);
    const refAfter = new RefModel(T0);
    const ts = TrimStack.open({ dir, initialT: T0, crashHook: crashAt(point) });
    for (const b of seedBatches()) {
      ts.writeBatch(b);
      refBefore.writeBatch(b);
      refAfter.writeBatch(b);
    }
    const newT = T0 + 40 * DAY;
    refAfter.maintain(newT);
    assert.throws(() => ts.maintain(newT), /simulated crash/);
    // reopen without a hook and check against exactly one of the two states
    const ts2 = reopen(dir);
    const ref = ts2.t === newT ? refAfter : refBefore;
    assert.ok(ts2.t === newT || ts2.t === T0, `unexpected T ${ts2.t} after crash at ${point}`);
    assertStateMatches(ts2, ref, ['r1', 'r2']);
    ts2.close();
  }
});

test('crash during cold-correction maintenance preserves either full state', () => {
  for (const point of MAINTAIN_POINTS_WITH_SWEEP) {
    const dir = tmpDir();
    const ts = TrimStack.open({ dir, initialT: T0 });
    const refBefore = new RefModel(T0);
    const refAfter = new RefModel(T0);
    const b1 = [{ resource: 'r1', hour: T0 - 35 * DAY, revision: 1, utilization: 200 }];
    ts.writeBatch(b1);
    refBefore.writeBatch(b1);
    refAfter.writeBatch(b1);
    ts.maintain(T0 + DAY); // archive the cold hour
    refBefore.maintain(T0 + DAY);
    refAfter.maintain(T0 + DAY);
    // correction for the archived cold hour, then a crashing maintenance
    const b2 = [{ resource: 'r1', hour: T0 - 35 * DAY, revision: 2, utilization: 999 }];
    ts.writeBatch(b2);
    refBefore.writeBatch(b2);
    refAfter.writeBatch(b2);
    const newT = T0 + 2 * DAY;
    refAfter.maintain(newT);
    const tsCrash = TrimStack.open({ dir, crashHook: crashAt(point) });
    assert.throws(() => tsCrash.maintain(newT), /simulated crash/);
    const ts2 = reopen(dir);
    const ref = ts2.t === newT ? refAfter : refBefore;
    assertStateMatches(ts2, ref, ['r1']);
    ts2.close();
  }
});

test('crash during expiry cleanup never resurrects expired data', () => {
  for (const point of MAINTAIN_POINTS_WITH_SWEEP) {
    const dir = tmpDir();
    const ts = TrimStack.open({ dir, initialT: T0 });
    const b = [
      { resource: 'r1', hour: T0 - 35 * DAY, revision: 1, utilization: 500 },
      { resource: 'r1', hour: T0 - 5 * DAY, revision: 1, utilization: 100 },
    ];
    ts.writeBatch(b);
    // first maintenance archives the cold hour T0-35d
    ts.maintain(T0 + 10 * DAY);
    const refBefore = new RefModel(T0);
    refBefore.writeBatch(b);
    refBefore.maintain(T0 + 10 * DAY);
    const refAfter = new RefModel(T0);
    refAfter.writeBatch(b);
    refAfter.maintain(T0 + 10 * DAY);
    // second maintenance pushes hour T0-35d out of retention and deletes its archive
    const newT = T0 + 70 * DAY;
    refAfter.maintain(newT);
    const tsCrash = TrimStack.open({ dir, crashHook: crashAt(point) });
    assert.throws(() => tsCrash.maintain(newT), /simulated crash/);
    const ts2 = reopen(dir);
    const ref = ts2.t === newT ? refAfter : refBefore;
    assert.ok(ts2.t === newT || ts2.t === T0 + 10 * DAY, `unexpected T ${ts2.t} after crash at ${point}`);
    assertStateMatches(ts2, ref, ['r1']);
    // late rewrite of the expired hour must stay ignored
    const late = [{ resource: 'r1', hour: T0 - 35 * DAY, revision: 9, utilization: 9999 }];
    ts2.writeBatch(late);
    ref.writeBatch(late);
    assertStateMatches(ts2, ref, ['r1']);
    ts2.close();
  }
});

test('recovery itself can be interrupted repeatedly; data survives', () => {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: T0 });
  const ref = new RefModel(T0);
  const b1 = [{ resource: 'r1', hour: T0 - 35 * DAY, revision: 1, utilization: 200 }];
  ts.writeBatch(b1);
  ref.writeBatch(b1);
  ts.maintain(T0 + DAY); // archive the cold hour
  ref.maintain(T0 + DAY);
  const b2 = [{ resource: 'r1', hour: T0 - 35 * DAY, revision: 2, utilization: 999 }];
  ts.writeBatch(b2);
  ref.writeBatch(b2);
  // crash after commit: the superseded archive generation is left pending deletion
  const newT = T0 + 2 * DAY;
  ref.maintain(newT);
  const tsCrash = TrimStack.open({ dir, crashHook: crashAt('maintain.committed') });
  assert.throws(() => tsCrash.maintain(newT), /simulated crash/);
  // recovery interrupted at several points in a row
  for (const point of ['recover.sweepOrphan', 'recover.orphansSwept', 'recover.sweepPending', 'recover.pendingSwept']) {
    assert.throws(() => reopen(dir, crashAt(point)), /simulated crash/);
  }
  // final open succeeds and matches the committed state
  const ts2 = reopen(dir);
  assert.equal(ts2.t, newT);
  assertStateMatches(ts2, ref, ['r1']);
  ts2.close();
});

test('retried writes and maintenance never double-count or lose confirmed data', () => {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: T0 });
  const ref = new RefModel(T0);
  const batch = seedBatches()[0];

  // batch unconfirmed (rolled back): retry applies it once
  const tsW1 = TrimStack.open({ dir, crashHook: crashAt('write.inTransaction') });
  assert.throws(() => tsW1.writeBatch(batch), /simulated crash/);
  const ts1 = reopen(dir);
  ts1.writeBatch(batch);
  ref.writeBatch(batch);
  assertStateMatches(ts1, ref, ['r1', 'r2']);

  // batch unconfirmed (committed but caller saw failure): retry is idempotent
  const tsW2 = TrimStack.open({ dir, crashHook: crashAt('write.committed') });
  assert.throws(() => tsW2.writeBatch(batch), /simulated crash/);
  const ts2 = reopen(dir);
  ts2.writeBatch(batch); // retry: same revisions, no change
  ref.writeBatch(batch);
  assertStateMatches(ts2, ref, ['r1', 'r2']);

  // maintenance unconfirmed after commit: retry with same newT is a no-op
  const newT = T0 + 40 * DAY;
  const tsM = TrimStack.open({ dir, crashHook: crashAt('maintain.committed') });
  assert.throws(() => tsM.maintain(newT), /simulated crash/);
  const ts3 = reopen(dir);
  ts3.maintain(newT); // retry: already there, must not fail
  ref.maintain(newT);
  assertStateMatches(ts3, ref, ['r1', 'r2']);
  ts3.close();
});

test('after final maintain, no useless archives remain and archives are independently readable', () => {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: T0 });
  const ref = new RefModel(T0);
  for (const b of seedBatches()) {
    ts.writeBatch(b);
    ref.writeBatch(b);
  }
  // crash once to leave orphans/pending behind, then finish cleanly
  const tsCrash = TrimStack.open({ dir, crashHook: crashAt('maintain.filesWritten') });
  assert.throws(() => tsCrash.maintain(T0 + 40 * DAY), /simulated crash/);
  const ts2 = reopen(dir);
  ts2.maintain(T0 + 40 * DAY);
  ref.maintain(T0 + 40 * DAY);
  ts2.maintain(T0 + 45 * DAY);
  ref.maintain(T0 + 45 * DAY);
  ts2.close();

  // independently read every archive file and rebuild the cold-range content
  const archivesDir = path.join(dir, 'archives');
  const files = fs.readdirSync(archivesDir);
  assert.ok(files.length > 0, 'expected cold archives to exist');
  const seen = new Map<string, MetricInput>();
  const coldEnd = ref.t - HOT_HOURS;
  const retentionStart = ref.t - RETENTION_HOURS;
  for (const f of files) {
    assert.match(f, /^cold-\d+-[0-9a-f-]+\.json\.gz$/, `unexpected file ${f}`);
    for (const r of readArchive(path.join(archivesDir, f))) {
      assert.ok(r.hour >= retentionStart && r.hour < coldEnd, `archive record outside cold range: ${JSON.stringify(r)}`);
      const key = `${r.resource} ${r.hour}`;
      assert.ok(!seen.has(key), `duplicate archive record for ${key}`);
      seen.set(key, r);
    }
  }
  // every cold-range hour the reference model holds must be in exactly one archive
  for (const resource of ['r1', 'r2']) {
    for (let h = retentionStart; h < coldEnd; h += 1) {
      const expected = ref.query(resource, h, h + 1);
      const got = seen.get(`${resource} ${h}`);
      if (expected.hours === 0) {
        assert.ok(got === undefined || got.resource !== resource, `unexpected archived ${resource}@${h}`);
      } else if (got !== undefined) {
        assert.equal(got.utilization, expected.totalUtilization, `archived content mismatch at ${resource}@${h}`);
      }
    }
  }
});
