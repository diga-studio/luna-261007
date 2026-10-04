import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrimStackStore, type CrashHooks, type MetricRecord, type StoreOptions } from '../src/index.js';
import { cleanupDir, RefModel, tmpDir } from './helpers.js';

const T0 = 1_000_000;

function rec(resource: string, hour: number, revision: number, cpu: number): MetricRecord {
  return { resource, hour, revision, cpu };
}

function open(dir: string, options?: StoreOptions): TrimStackStore {
  return TrimStackStore.open(dir, options ?? {});
}

/** Returns a hook function that throws the first n times it is called. */
function throwTimes(n: number): () => void {
  let remaining = n;
  return () => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error('simulated crash');
    }
  };
}

function archivesOnDisk(dir: string): string[] {
  const d = path.join(dir, 'archives');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
}

function assertFilesConsistent(dir: string, store: TrimStackStore): void {
  assert.deepEqual(archivesOnDisk(dir), store.listArchiveFiles(), 'disk files must match active archives');
}

function seedStore(dir: string): { records: MetricRecord[]; model: RefModel } {
  const store = open(dir, { initialHour: T0 });
  const records: MetricRecord[] = [];
  for (let h = T0 - 900; h < T0; h += 3) {
    records.push(rec('r1', h, 1, h % 800), rec('r2', h, 2, (h * 3) % 900));
  }
  store.writeBatch(records);
  store.close();
  const model = new RefModel(T0);
  model.writeBatch(records);
  return { records, model };
}

test('crashed write batch leaves no partial updates', () => {
  const dir = tmpDir();
  try {
    const { model } = seedStore(dir);
    const batch = [rec('r1', T0 - 10, 5, 9999), rec('r2', T0 - 20, 5, 8888)];
    let store = open(dir, { crashHooks: { onWriteBatchBeforeCommit: throwTimes(1) } });
    assert.throws(() => store.writeBatch(batch), /simulated crash/);
    store.close();

    store = open(dir);
    // Batch is fully absent: queries match the model that never saw it.
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, T0), model.query(res, 0, T0));
    }
    model.writeBatch(batch);
    store.writeBatch(batch); // retry succeeds
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, T0), model.query(res, 0, T0));
    }
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('maintain crashed before commit: T unchanged, orphan file swept, retry succeeds', () => {
  const dir = tmpDir();
  try {
    const { model } = seedStore(dir);
    const newT = T0 + 500;
    let store = open(dir, { crashHooks: { onMaintainFileRenamed: throwTimes(1) } });
    assert.throws(() => store.maintain(newT), /simulated crash/);
    store.close();

    store = open(dir);
    assert.equal(store.currentHour, T0, 'T must not have advanced');
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, T0), model.query(res, 0, T0));
    }
    assertFilesConsistent(dir, store); // orphan archive file swept during recovery

    store.maintain(newT); // retry
    model.maintain(newT);
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, newT), model.query(res, 0, newT));
    }
    assertFilesConsistent(dir, store);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('maintain crashed after commit: T advanced, data complete, cleanup finishes on reopen', () => {
  const dir = tmpDir();
  try {
    const { model } = seedStore(dir);
    const newT = T0 + 500;
    let store = open(dir, { crashHooks: { onMaintainAfterCommit: throwTimes(1) } });
    assert.throws(() => store.maintain(newT), /simulated crash/);
    store.close();

    model.maintain(newT);
    store = open(dir);
    assert.equal(store.currentHour, newT, 'committed T must survive');
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, newT), model.query(res, 0, newT));
    }
    store.maintain(newT); // idempotent retry completes cleanup
    assertFilesConsistent(dir, store);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('maintain crashed during obsolete-file cleanup: reopen finishes the job', () => {
  const dir = tmpDir();
  try {
    const { model } = seedStore(dir);
    const newT = T0 + 500;
    let store = open(dir);
    store.maintain(newT); // create the first generation of cold archives
    model.maintain(newT);
    const corrections = [rec('r1', T0 - 800, 7, 111), rec('r2', T0 - 700, 7, 222)];
    store.writeBatch(corrections); // cold corrections force archive rewrites
    model.writeBatch(corrections);
    store.close();

    const newT2 = newT + 100;
    store = open(dir, { crashHooks: { onMaintainDuringCleanup: throwTimes(1) } });
    assert.throws(() => store.maintain(newT2), /simulated crash/);
    store.close();

    model.maintain(newT2);
    store = open(dir);
    assert.equal(store.currentHour, newT2);
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, newT2), model.query(res, 0, newT2));
    }
    store.maintain(newT2); // retry: all stale files must be gone afterwards
    assertFilesConsistent(dir, store);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('recovery itself can be interrupted repeatedly and still converges', () => {
  const dir = tmpDir();
  try {
    const { model } = seedStore(dir);
    const newT = T0 + 500;
    let store = open(dir);
    store.maintain(newT); // first generation of archives
    model.maintain(newT);
    const corrections = [rec('r1', T0 - 800, 7, 111), rec('r2', T0 - 700, 7, 222)];
    store.writeBatch(corrections);
    model.writeBatch(corrections);
    store.close();

    const newT2 = newT + 100;
    store = open(dir, { crashHooks: { onMaintainAfterCommit: throwTimes(1) } });
    assert.throws(() => store.maintain(newT2), /simulated crash/);
    store.close();

    // Recovery interrupted twice in a row.
    assert.throws(() => open(dir, { crashHooks: { onRecoverDuringCleanup: throwTimes(1) } }), /simulated crash/);
    assert.throws(() => open(dir, { crashHooks: { onRecoverDuringCleanup: throwTimes(2) } }), /simulated crash/);

    model.maintain(newT2);
    store = open(dir);
    assert.equal(store.currentHour, newT2);
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, newT2), model.query(res, 0, newT2));
    }
    store.maintain(newT2 + 24); // one more maintenance: everything stale must be gone
    model.maintain(newT2 + 24);
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, newT2 + 24), model.query(res, 0, newT2 + 24));
    }
    assertFilesConsistent(dir, store);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('cold correction followed by crashed maintain keeps either full state, never partial', () => {
  const dir = tmpDir();
  try {
    const { model } = seedStore(dir);
    const newT = T0 + 500;
    let store = open(dir);
    store.maintain(newT);
    model.maintain(newT);
    const correction = [rec('r1', T0 - 800, 9, 1234), rec('r2', T0 - 850, 9, 4321)];
    store.writeBatch(correction);
    model.writeBatch(correction);
    store.close();

    // Crash the folding maintenance right before commit.
    store = open(dir, { crashHooks: { onMaintainBeforeCommit: throwTimes(1) } });
    assert.throws(() => store.maintain(newT + 100), /simulated crash/);
    store.close();

    // Unconfirmed maintain is fully absent, but the confirmed correction survives.
    store = open(dir);
    assert.equal(store.currentHour, newT);
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, newT), model.query(res, 0, newT));
    }
    // Retry the maintenance; corrections get folded into archives.
    store.maintain(newT + 100);
    model.maintain(newT + 100);
    for (const res of ['r1', 'r2']) {
      assert.deepEqual(store.query(res, 0, newT + 100), model.query(res, 0, newT + 100));
    }
    assertFilesConsistent(dir, store);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
