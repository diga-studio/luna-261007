import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrimStackStore, readArchiveFile, type MetricRecord } from '../src/index.js';
import { cleanupDir, HOT_HOURS, RETENTION_HOURS, RefModel, tmpDir } from './helpers.js';

const T0 = 1_000_000;

function rec(resource: string, hour: number, revision: number, cpu: number): MetricRecord {
  return { resource, hour, revision, cpu };
}

test('hot writes keep highest revision only', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    store.writeBatch([
      rec('a', T0 - 1, 1, 100),
      rec('a', T0 - 1, 3, 300),
      rec('a', T0 - 1, 2, 200), // lower than current max: ignored
      rec('a', T0 - 1, 3, 999), // duplicate revision: ignored
      rec('a', T0 - 2, 1, 50),
    ]);
    assert.deepEqual(store.query('a', T0 - 10, T0), { hours: 2, totalCpu: 350, maxCpu: 300 });
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('retention and hot/cold boundaries are exact', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    const model = new RefModel(T0);
    const records = [
      rec('r', T0 - RETENTION_HOURS - 1, 1, 11), // expired: ignored
      rec('r', T0 - RETENTION_HOURS, 1, 22), // oldest retained, cold
      rec('r', T0 - HOT_HOURS - 1, 1, 33), // coldest cold hour... actually cold
      rec('r', T0 - HOT_HOURS, 1, 44), // first hot hour
      rec('r', T0 - 1, 1, 55), // newest
    ];
    store.writeBatch(records);
    model.writeBatch(records);
    for (const [from, to] of [
      [T0 - RETENTION_HOURS - 100, T0],
      [T0 - RETENTION_HOURS - 1, T0 - RETENTION_HOURS + 1],
      [T0 - HOT_HOURS - 1, T0 - HOT_HOURS + 1],
      [T0 - 1, T0],
    ] as const) {
      assert.deepEqual(store.query('r', from, to), model.query('r', from, to), `range [${from},${to})`);
    }
    assert.equal(store.query('r', 0, T0).hours, 4);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('first cold transition moves hot data into compressed archives', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    const model = new RefModel(T0);
    const records: MetricRecord[] = [];
    for (let h = T0 - 800; h < T0; h++) records.push(rec('r', h, 1, h % 1000));
    store.writeBatch(records);
    model.writeBatch(records);

    const newT = T0 + 200;
    store.maintain(newT);
    model.maintain(newT);
    assert.equal(store.currentHour, newT);

    const archives = fs.readdirSync(path.join(dir, 'archives'));
    assert.ok(archives.length > 0, 'expected cold archive files');
    for (const [from, to] of [
      [0, newT],
      [T0 - 800, T0 - 600],
      [T0 - 10, newT],
    ] as const) {
      assert.deepEqual(store.query('r', from, to), model.query('r', from, to));
    }
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('cold corrections are visible immediately and folded by maintenance', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    store.writeBatch([rec('r', T0 - 10, 1, 100)]);
    store.maintain(T0 + 1000); // hour T0-10 is now cold

    store.writeBatch([rec('r', T0 - 10, 2, 777)]); // correct cold data
    assert.deepEqual(store.query('r', T0 - 10, T0 - 9), { hours: 1, totalCpu: 777, maxCpu: 777 });

    store.writeBatch([rec('r', T0 - 10, 1, 5)]); // stale revision: ignored
    assert.deepEqual(store.query('r', T0 - 10, T0 - 9), { hours: 1, totalCpu: 777, maxCpu: 777 });

    store.maintain(T0 + 1001); // fold correction into archive
    assert.deepEqual(store.query('r', T0 - 10, T0 - 9), { hours: 1, totalCpu: 777, maxCpu: 777 });
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('expired hours are dropped and late revisions for them are ignored', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    const model = new RefModel(T0);
    store.writeBatch([rec('r', T0 - 1, 1, 100), rec('r', T0 - 2, 1, 200)]);
    model.writeBatch([rec('r', T0 - 1, 1, 100), rec('r', T0 - 2, 1, 200)]);

    const newT = T0 - 1 + RETENTION_HOURS; // hour T0-1 expires exactly at newT
    store.maintain(newT);
    model.maintain(newT);
    assert.deepEqual(store.query('r', 0, newT), model.query('r', 0, newT));
    assert.equal(store.query('r', 0, newT).hours, 1); // only T0-2 remains

    store.writeBatch([rec('r', T0 - 1, 99, 9999)]); // expired: ignored despite high revision
    model.writeBatch([rec('r', T0 - 1, 99, 9999)]);
    assert.deepEqual(store.query('r', 0, newT), model.query('r', 0, newT));
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('maintenance can jump across many archive and expiry boundaries', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    const model = new RefModel(T0);
    const records: MetricRecord[] = [];
    for (let h = T0 - RETENTION_HOURS; h < T0; h += 7) records.push(rec('r', h, 1, h % 500));
    store.writeBatch(records);
    model.writeBatch(records);

    store.maintain(T0 + 100 * 24); // jump 100 days: everything written expires
    model.maintain(T0 + 100 * 24);
    assert.deepEqual(store.query('r', 0, T0 + 100 * 24), model.query('r', 0, T0 + 100 * 24));
    assert.equal(store.query('r', 0, T0 + 100 * 24).hours, 0);
    assert.equal(fs.readdirSync(path.join(dir, 'archives')).length, 0, 'all archives expired');
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('maintenance rejects moving time backwards, equal time is a no-op', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    store.writeBatch([rec('r', T0 - 1, 1, 100)]);
    store.maintain(T0 + 10);
    assert.throws(() => store.maintain(T0 + 9));
    store.maintain(T0 + 10); // idempotent retry
    assert.deepEqual(store.query('r', 0, T0 + 10), { hours: 1, totalCpu: 100, maxCpu: 100 });
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('data persists across close and reopen', () => {
  const dir = tmpDir();
  try {
    let store = TrimStackStore.open(dir, { initialHour: T0 });
    store.writeBatch([rec('r', T0 - 5, 1, 100), rec('r', T0 - 1000, 2, 300)]);
    store.maintain(T0 + 500);
    store.close();

    store = TrimStackStore.open(dir);
    assert.equal(store.currentHour, T0 + 500);
    assert.deepEqual(store.query('r', 0, T0 + 500), { hours: 2, totalCpu: 400, maxCpu: 300 });
    store.close();

    assert.throws(() => TrimStackStore.open(dir, { initialHour: T0 + 1 }), /does not match/);
  } finally {
    cleanupDir(dir);
  }
});

test('cold archives are independently readable with full metric content', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    const records: MetricRecord[] = [];
    for (let h = T0 - 50; h < T0; h++) {
      records.push(rec('a', h, 1, h % 700), rec('b', h, 3, (h * 7) % 900));
    }
    store.writeBatch(records);
    store.maintain(T0 + 1000);

    const files = fs.readdirSync(path.join(dir, 'archives'));
    assert.ok(files.length > 0);
    const all = files.flatMap((f) => readArchiveFile(path.join(dir, 'archives', f)));
    const expected = records.filter((r) => r.hour >= T0 + 1000 - RETENTION_HOURS && r.hour < T0 + 1000 - HOT_HOURS);
    const sortKey = (r: MetricRecord) => `${r.resource}|${r.hour}`;
    assert.deepEqual(
      [...all].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1)),
      [...expected].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1)),
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('querying an unknown resource returns empty stats', () => {
  const dir = tmpDir();
  try {
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    store.writeBatch([rec('r', T0 - 1, 1, 100)]);
    assert.deepEqual(store.query('nope', 0, T0), { hours: 0, totalCpu: 0, maxCpu: 0 });
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
