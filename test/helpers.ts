import { MetricInput, StatsResult, HOT_HOURS, RETENTION_HOURS } from '../src/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trimstack-test-'));
}

/**
 * Reference model: keeps every accepted input in memory and applies the
 * business rules directly. The library under test must always agree with it.
 */
export class RefModel {
  t: number;
  private data = new Map<string, MetricInput>();

  constructor(initialT: number) {
    this.t = initialT;
  }

  private retentionStart(): number {
    return this.t - RETENTION_HOURS;
  }

  writeBatch(records: MetricInput[]): void {
    for (const r of records) {
      if (r.hour < this.retentionStart() || r.hour >= this.t) continue;
      const key = `${r.resource} ${r.hour}`;
      const prev = this.data.get(key);
      if (prev === undefined || r.revision > prev.revision) {
        this.data.set(key, r);
      }
    }
  }

  maintain(newT: number): void {
    this.t = newT;
    const lo = this.retentionStart();
    for (const [key, r] of this.data) {
      if (r.hour < lo) this.data.delete(key);
    }
  }

  query(resource: string, startHour: number, endHour: number): StatsResult {
    const lo = Math.max(startHour, this.retentionStart());
    const hi = Math.min(endHour, this.t);
    let hours = 0;
    let totalUtilization = 0;
    let maxUtilization = 0;
    if (lo < hi) {
      for (const r of this.data.values()) {
        if (r.resource !== resource || r.hour < lo || r.hour >= hi) continue;
        hours += 1;
        totalUtilization += r.utilization;
        if (r.utilization > maxUtilization) maxUtilization = r.utilization;
      }
    }
    return { hours, totalUtilization, maxUtilization };
  }
}

/** Deterministic PRNG (mulberry32) for reproducible tests. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function assertStatsEqual(actual: StatsResult, expected: StatsResult): void {
  if (
    actual.hours !== expected.hours ||
    actual.totalUtilization !== expected.totalUtilization ||
    actual.maxUtilization !== expected.maxUtilization
  ) {
    throw new Error(`stats mismatch: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

export const DAY = 24;
export { HOT_HOURS, RETENTION_HOURS };
