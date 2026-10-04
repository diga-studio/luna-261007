import { test } from 'node:test';
import { TrimStack, MetricInput, RETENTION_HOURS } from '../src/index.js';
import { RefModel, assertStatsEqual, makeRng, randInt, tmpDir, DAY } from './helpers.js';

test('randomized workload agrees with reference model (with reopens)', () => {
  const rng = makeRng(20261005);
  const dir = tmpDir();
  const t0 = 5_000_000;
  const resources = Array.from({ length: 12 }, (_, i) => `res-${i}`);
  let ts = TrimStack.open({ dir, initialT: t0 });
  const ref = new RefModel(t0);
  let t = t0;
  // same (resource, hour, revision) must always carry identical content
  const utilOf = (resource: string, hour: number, revision: number): number => {
    let h = revision * 2654435761 + hour * 40503;
    for (const c of resource) h = (h * 33 + c.charCodeAt(0)) | 0;
    return Math.abs(h) % 10001;
  };

  for (let op = 0; op < 400; op += 1) {
    const kind = rng();
    if (kind < 0.55) {
      // write a batch: fresh hours, corrections, stale revisions, expired hours
      const batch: MetricInput[] = [];
      const n = randInt(rng, 1, 30);
      for (let i = 0; i < n; i += 1) {
        const resource = resources[randInt(rng, 0, resources.length - 1)];
        const hour = t - randInt(rng, 1, 100 * DAY); // may be expired
        batch.push({
          resource,
          hour,
          revision: 0,
          utilization: 0,
        });
      }
      for (const rec of batch) {
        rec.revision = randInt(rng, 0, 6);
        rec.utilization = utilOf(rec.resource, rec.hour, rec.revision);
      }
      ts.writeBatch(batch);
      ref.writeBatch(batch);
    } else if (kind < 0.8) {
      // advance business time
      t += randInt(rng, 1, 5 * DAY);
      ts.maintain(t);
      ref.maintain(t);
    } else if (kind < 0.9) {
      // reopen the store
      ts.close();
      ts = TrimStack.open({ dir });
    } else {
      // random range query, possibly reaching outside retention
      const resource = resources[randInt(rng, 0, resources.length - 1)];
      const a = t - randInt(rng, 0, 120 * DAY);
      const b = a + randInt(rng, 0, 60 * DAY);
      assertStatsEqual(ts.query(resource, a, b), ref.query(resource, a, b));
    }
  }
  // final full-range comparison for every resource
  for (const r of resources) {
    assertStatsEqual(ts.query(r, 0, t), ref.query(r, 0, t));
  }
  ts.close();
});

test('acceptance scale: 500 resources x 90 days of hourly metrics', () => {
  const dir = tmpDir();
  const resources = Array.from({ length: 500 }, (_, i) => `res-${i}`);
  const days = 90;
  // choose T so that all generated hours are valid at write time
  const t0 = 100_000_000;
  const firstHour = t0 - (days + 5) * 24;
  let ts = TrimStack.open({ dir, initialT: t0 });
  const ref = new RefModel(t0);

  // one batch per simulated day: 500 resources x 24 hours
  for (let d = 0; d < days; d += 1) {
    const batch: MetricInput[] = [];
    for (let h = 0; h < 24; h += 1) {
      const hour = firstHour + d * 24 + h;
      for (const resource of resources) {
        batch.push({
          resource,
          hour,
          revision: 1,
          utilization: (hour * 31 + resource.length * 7 + d) % 10001,
        });
      }
    }
    ts.writeBatch(batch);
    ref.writeBatch(batch);
  }
  // corrections for a slice of cold and hot hours
  const corrections: MetricInput[] = [];
  for (let i = 0; i < resources.length; i += 10) {
    corrections.push({ resource: resources[i], hour: firstHour + 10 * 24, revision: 2, utilization: 7777 });
    corrections.push({ resource: resources[i], hour: t0 - 5 * 24, revision: 2, utilization: 3333 });
  }
  ts.writeBatch(corrections);
  ref.writeBatch(corrections);

  // advance in daily steps so archival, correction folding and expiry all run
  for (let d = 1; d <= 40; d += 1) {
    ts.maintain(t0 + d * 24);
    ref.maintain(t0 + d * 24);
  }
  const t = t0 + 40 * 24;

  // sample queries across resources and ranges
  const rng = makeRng(42);
  for (let q = 0; q < 60; q += 1) {
    const resource = resources[randInt(rng, 0, resources.length - 1)];
    const a = t - randInt(rng, 0, 100 * 24);
    const b = a + randInt(rng, 1, 95 * 24);
    assertStatsEqual(ts.query(resource, a, b), ref.query(resource, a, b));
  }
  // full-range queries for a few resources
  for (let i = 0; i < resources.length; i += 50) {
    assertStatsEqual(ts.query(resources[i], 0, t), ref.query(resources[i], 0, t));
  }
  ts.close();

  // reopen and verify persistence of the final state
  const ts2 = TrimStack.open({ dir });
  for (let i = 0; i < resources.length; i += 50) {
    assertStatsEqual(ts2.query(resources[i], 0, t), ref.query(resources[i], 0, t));
  }
  ts2.close();
});
