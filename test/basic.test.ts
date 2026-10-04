import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TrimStack } from '../src/index.js';
import { RefModel, assertStatsEqual, tmpDir, DAY } from './helpers.js';

test('create requires initialT, reopen keeps T', () => {
  const dir = tmpDir();
  assert.throws(() => TrimStack.open({ dir }), /initialT/);
  const ts = TrimStack.open({ dir, initialT: 100000 });
  assert.equal(ts.t, 100000);
  ts.close();
  const ts2 = TrimStack.open({ dir, initialT: 999 });
  assert.equal(ts2.t, 100000);
  ts2.close();
});

test('hot write, dedupe by revision, missing hours are not zero', () => {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: 1000 });
  ts.writeBatch([
    { resource: 'a', hour: 900, revision: 1, utilization: 500 },
    { resource: 'a', hour: 901, revision: 1, utilization: 700 },
  ]);
  // lower and equal revisions do not change the result
  ts.writeBatch([
    { resource: 'a', hour: 900, revision: 0, utilization: 9999 },
    { resource: 'a', hour: 900, revision: 1, utilization: 9999 },
  ]);
  // higher revision wins
  ts.writeBatch([{ resource: 'a', hour: 900, revision: 2, utilization: 300 }]);
  const stats = ts.query('a', 0, 1000);
  assert.deepEqual(stats, { hours: 2, totalUtilization: 1000, maxUtilization: 700 });
  ts.close();
});

test('expired hours are ignored even with higher revision', () => {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: 1000 });
  ts.writeBatch([{ resource: 'a', hour: 500, revision: 1, utilization: 100 }]);
  ts.maintain(1000 + 100 * DAY); // retention start moves past hour 500
  ts.writeBatch([{ resource: 'a', hour: 500, revision: 9, utilization: 9999 }]);
  const stats = ts.query('a', 0, 1000 + 100 * DAY);
  assert.deepEqual(stats, { hours: 0, totalUtilization: 0, maxUtilization: 0 });
  ts.close();
});

test('invalid records are rejected', () => {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: 1000 });
  assert.throws(() => ts.writeBatch([{ resource: 'a', hour: 1, revision: 1, utilization: 10001 }]));
  assert.throws(() => ts.writeBatch([{ resource: 'a', hour: 1, revision: 1, utilization: -1 }]));
  assert.throws(() => ts.writeBatch([{ resource: 'a', hour: 1, revision: -1, utilization: 1 }]));
  assert.throws(() => ts.writeBatch([{ resource: 'a', hour: 1.5, revision: 1, utilization: 1 }]));
  ts.close();
});

test('maintain rejects moving T backwards, equal T is a no-op', () => {
  const dir = tmpDir();
  const ts = TrimStack.open({ dir, initialT: 1000 });
  ts.maintain(1000); // no-op, retry-friendly
  assert.equal(ts.t, 1000);
  assert.throws(() => ts.maintain(999));
  ts.close();
});

test('query agrees with reference model on basic flow', () => {
  const dir = tmpDir();
  const t0 = 1_000_000;
  const ts = TrimStack.open({ dir, initialT: t0 });
  const ref = new RefModel(t0);
  const batch = [
    { resource: 'r1', hour: t0 - 10, revision: 1, utilization: 100 },
    { resource: 'r1', hour: t0 - 20, revision: 1, utilization: 200 },
    { resource: 'r2', hour: t0 - 10, revision: 1, utilization: 300 },
  ];
  ts.writeBatch(batch);
  ref.writeBatch(batch);
  ts.maintain(t0 + 40 * DAY);
  ref.maintain(t0 + 40 * DAY);
  assertStatsEqual(ts.query('r1', 0, t0 + 40 * DAY), ref.query('r1', 0, t0 + 40 * DAY));
  assertStatsEqual(ts.query('r2', 0, t0 + 40 * DAY), ref.query('r2', 0, t0 + 40 * DAY));
  ts.close();
});
