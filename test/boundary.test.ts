import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TrimStack, HOT_HOURS, RETENTION_HOURS } from '../src/index.js';
import { RefModel, assertStatsEqual, tmpDir, DAY } from './helpers.js';

const T0 = 10_000_000;

function setup(): { ts: TrimStack; ref: RefModel; dir: string } {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: T0 });
  const ref = new RefModel(T0);
  return { ts, ref, dir };
}

test('hour exactly at T-30d is hot, hour T-30d-1 is cold', () => {
  const { ts, ref } = setup();
  const boundary = T0 - HOT_HOURS;
  const batch = [
    { resource: 'r', hour: boundary, revision: 1, utilization: 111 },
    { resource: 'r', hour: boundary - 1, revision: 1, utilization: 222 },
  ];
  ts.writeBatch(batch);
  ref.writeBatch(batch);
  // advance a little so maintenance actually archives
  ts.maintain(T0 + 1);
  ref.maintain(T0 + 1);
  assertStatsEqual(ts.query('r', boundary - 1, boundary + 1), ref.query('r', boundary - 1, boundary + 1));
  const stats = ts.query('r', 0, T0 + 1);
  assert.deepEqual(stats, { hours: 2, totalUtilization: 333, maxUtilization: 222 });
  ts.close();
});

test('hour exactly at T-90d is retained, hour T-90d-1 is dropped', () => {
  const { ts, ref } = setup();
  const boundary = T0 - RETENTION_HOURS;
  const batch = [
    { resource: 'r', hour: boundary, revision: 1, utilization: 111 },
    { resource: 'r', hour: boundary - 1, revision: 1, utilization: 222 },
  ];
  ts.writeBatch(batch);
  ref.writeBatch(batch);
  assertStatsEqual(ts.query('r', 0, T0), ref.query('r', 0, T0));
  const stats = ts.query('r', 0, T0);
  assert.deepEqual(stats, { hours: 1, totalUtilization: 111, maxUtilization: 111 });
  ts.close();
});

test('same hour corrected many times across hot and cold zones', () => {
  const { ts, ref } = setup();
  const hour = T0 - 10 * DAY; // starts hot
  for (let step = 0; step < 10; step += 1) {
    const rev = step + 1;
    const util = 1000 + step * 500;
    const batch = [{ resource: 'r', hour, revision: rev, utilization: util }];
    ts.writeBatch(batch);
    ref.writeBatch(batch);
    // advance 8 days per step: the hour crosses from hot into cold mid-way
    const newT = T0 + (step + 1) * 8 * DAY;
    ts.maintain(newT);
    ref.maintain(newT);
    assert.equal(ts.t, newT);
    assertStatsEqual(ts.query('r', hour, hour + 1), ref.query('r', hour, hour + 1));
  }
  // after 80 days of advancement the hour is deep in the cold zone
  const stats = ts.query('r', hour, hour + 1);
  assert.deepEqual(stats, { hours: 1, totalUtilization: 1000 + 9 * 500, maxUtilization: 1000 + 9 * 500 });
  ts.close();
});

test('correction of cold data is visible immediately, before and after maintenance', () => {
  const { ts, ref } = setup();
  const hour = T0 - 40 * DAY; // already cold at T0
  ts.writeBatch([{ resource: 'r', hour, revision: 1, utilization: 100 }]);
  ref.writeBatch([{ resource: 'r', hour, revision: 1, utilization: 100 }]);
  ts.maintain(T0 + DAY); // hour gets archived
  ref.maintain(T0 + DAY);
  // correction arrives while cold and archived
  ts.writeBatch([{ resource: 'r', hour, revision: 2, utilization: 555 }]);
  ref.writeBatch([{ resource: 'r', hour, revision: 2, utilization: 555 }]);
  // visible immediately (query merges hot correction over archive)
  assertStatsEqual(ts.query('r', hour, hour + 1), ref.query('r', hour, hour + 1));
  assert.equal(ts.query('r', hour, hour + 1).totalUtilization, 555);
  // and still correct after the next maintenance folds it into the archive
  ts.maintain(T0 + 2 * DAY);
  ref.maintain(T0 + 2 * DAY);
  assertStatsEqual(ts.query('r', hour, hour + 1), ref.query('r', hour, hour + 1));
  assert.equal(ts.query('r', hour, hour + 1).totalUtilization, 555);
  ts.close();
});

test('expiring boundary: data disappears exactly when T passes hour+90d', () => {
  const { ts, ref } = setup();
  const hour = T0 - 10 * DAY;
  ts.writeBatch([{ resource: 'r', hour, revision: 1, utilization: 42 }]);
  ref.writeBatch([{ resource: 'r', hour, revision: 1, utilization: 42 }]);
  // advance to the last T where the hour is still retained
  const lastT = hour + RETENTION_HOURS;
  ts.maintain(lastT);
  ref.maintain(lastT);
  assert.equal(ts.query('r', 0, lastT).hours, 1);
  // one more hour and it is gone
  ts.maintain(lastT + 1);
  ref.maintain(lastT + 1);
  assert.equal(ts.query('r', 0, lastT + 1).hours, 0);
  // a late higher-revision rewrite must not resurrect it
  ts.writeBatch([{ resource: 'r', hour, revision: 99, utilization: 9999 }]);
  ref.writeBatch([{ resource: 'r', hour, revision: 99, utilization: 9999 }]);
  assert.equal(ts.query('r', 0, lastT + 1).hours, 0);
  ts.close();
});

test('maintain can jump across multiple archive and expiry boundaries at once', () => {
  const { ts, ref } = setup();
  const batch = [];
  for (let i = 1; i <= 200; i += 1) {
    batch.push({ resource: `r${i % 7}`, hour: T0 - i * 10, revision: 1, utilization: i });
  }
  ts.writeBatch(batch);
  ref.writeBatch(batch);
  ts.maintain(T0 + 95 * DAY); // jumps past several windows and the expiry boundary
  ref.maintain(T0 + 95 * DAY);
  for (let i = 0; i < 7; i += 1) {
    assertStatsEqual(ts.query(`r${i}`, 0, T0 + 95 * DAY), ref.query(`r${i}`, 0, T0 + 95 * DAY));
  }
  ts.close();
});
