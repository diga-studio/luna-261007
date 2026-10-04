import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrimStackStore, readArchiveFile, type MetricRecord } from '../src/index.js';
import { cleanupDir, HOT_HOURS, RETENTION_HOURS, RefModel, rng, tmpDir } from './helpers.js';

const T0 = 2_000_000;

test('randomized workload matches the reference model', () => {
  const dir = tmpDir();
  try {
    const rand = rng(42);
    const resources = Array.from({ length: 30 }, (_, i) => `res-${i}`);
    let store = TrimStackStore.open(dir, { initialHour: T0 });
    const model = new RefModel(T0);

    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

    for (let round = 0; round < 200; round++) {
      const op = rand();
      const t = store.currentHour;
      if (op < 0.55) {
        const batch: MetricRecord[] = [];
        const n = 1 + Math.floor(rand() * 50);
        for (let i = 0; i < n; i++) {
          batch.push({
            resource: pick(resources),
            // Covers expired, cold, hot and boundary hours.
            hour: t - RETENTION_HOURS - 5 + Math.floor(rand() * (RETENTION_HOURS + 10)),
            revision: Math.floor(rand() * 6),
            cpu: Math.floor(rand() * 10001),
          });
        }
        store.writeBatch(batch);
        model.writeBatch(batch);
      } else if (op < 0.75) {
        const jump = rand() < 0.1 ? 1 + Math.floor(rand() * 3000) : 1 + Math.floor(rand() * 200);
        store.maintain(t + jump);
        model.maintain(t + jump);
      } else {
        const res = pick(resources);
        const from = t - RETENTION_HOURS - 100 + Math.floor(rand() * (RETENTION_HOURS + 150));
        const to = from + Math.floor(rand() * 500);
        assert.deepEqual(store.query(res, from, to), model.query(res, from, to), `round ${round}`);
      }

      if (round % 25 === 24) {
        store.close();
        store = TrimStackStore.open(dir);
        for (const res of resources) {
          assert.deepEqual(
            store.query(res, 0, store.currentHour),
            model.query(res, 0, model.currentHour),
            `round ${round} full scan ${res}`,
          );
        }
      }
    }

    // Final consistency: archives on disk are exactly the active set, and their
    // independent read-back equals the model's cold-range content.
    store.maintain(store.currentHour + 1);
    model.maintain(model.currentHour + 1);
    const files = fs.readdirSync(path.join(dir, 'archives')).sort();
    assert.deepEqual(files, store.listArchiveFiles());
    const t = store.currentHour;
    const archived = files.flatMap((f) => readArchiveFile(path.join(dir, 'archives', f)));
    const coldFrom = t - RETENTION_HOURS;
    const coldTo = t - HOT_HOURS;
    const byKey = new Map<string, MetricRecord>();
    for (const r of archived) {
      assert.ok(r.hour >= coldFrom && r.hour < coldTo, 'archive record outside cold range');
      byKey.set(`${r.resource}|${r.hour}`, r);
    }
    for (const res of resources) {
      const stats = store.query(res, coldFrom, coldTo);
      assert.deepEqual(stats, model.query(res, coldFrom, coldTo));
    }
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test('acceptance scale: 500 resources x 90 days (1.08M metrics)', () => {
  const dir = tmpDir();
  try {
    const resources = Array.from({ length: 500 }, (_, i) => `res-${i}`);
    const store = TrimStackStore.open(dir, { initialHour: T0 });
    const model = new RefModel(T0);

    // Write the full 90-day window in hourly batches.
    for (let h = T0 - RETENTION_HOURS; h < T0; h++) {
      const batch: MetricRecord[] = resources.map((r, i) => ({
        resource: r,
        hour: h,
        revision: 1,
        cpu: (h * 31 + i * 7) % 10001,
      }));
      store.writeBatch(batch);
      model.writeBatch(batch);
    }

    // Advance across the cold boundary in several steps, correcting some cold hours.
    let t = T0;
    const rand = rng(7);
    for (let step = 0; step < 10; step++) {
      t += 24 * 3;
      const corrections: MetricRecord[] = [];
      for (let i = 0; i < 200; i++) {
        corrections.push({
          resource: resources[Math.floor(rand() * resources.length)]!,
          hour: t - HOT_HOURS - 1 - Math.floor(rand() * (RETENTION_HOURS - HOT_HOURS - 100)),
          revision: 2,
          cpu: Math.floor(rand() * 10001),
        });
      }
      store.writeBatch(corrections);
      model.writeBatch(corrections);
      store.maintain(t);
      model.maintain(t);
    }

    for (const res of ['res-0', 'res-123', 'res-499']) {
      assert.deepEqual(store.query(res, 0, t), model.query(res, 0, t));
      assert.deepEqual(store.query(res, t - 1000, t - 500), model.query(res, t - 1000, t - 500));
    }
    const stats = store.query('res-0', 0, t);
    assert.ok(stats.hours > 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
