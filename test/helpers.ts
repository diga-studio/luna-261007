import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HourlyStats, MetricRecord } from '../src/index.js';

export const HOT_HOURS = 30 * 24;
export const RETENTION_HOURS = 90 * 24;

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trimstack-'));
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reference model: keeps every accepted input in memory and applies the
 * business rules directly, with no hot/cold split.
 */
export class RefModel {
  private hour: number;
  private readonly data = new Map<string, MetricRecord>();

  constructor(initialHour: number) {
    this.hour = initialHour;
  }

  get currentHour(): number {
    return this.hour;
  }

  writeBatch(records: MetricRecord[]): void {
    const retainStart = this.hour - RETENTION_HOURS;
    for (const rec of records) {
      if (rec.hour < retainStart || rec.hour >= this.hour) continue;
      const key = `${rec.resource}|${rec.hour}`;
      const prev = this.data.get(key);
      if (prev === undefined || rec.revision > prev.revision) {
        this.data.set(key, { ...rec });
      }
    }
  }

  maintain(newHour: number): void {
    if (newHour < this.hour) throw new Error('backwards');
    this.hour = newHour;
  }

  query(resource: string, fromHour: number, toHour: number): HourlyStats {
    const from = Math.max(fromHour, this.hour - RETENTION_HOURS);
    const to = Math.min(toHour, this.hour);
    const result: HourlyStats = { hours: 0, totalCpu: 0, maxCpu: 0 };
    if (from >= to) return result;
    for (const rec of this.data.values()) {
      if (rec.resource !== resource) continue;
      if (rec.hour < from || rec.hour >= to) continue;
      result.hours += 1;
      result.totalCpu += rec.cpu;
      if (rec.cpu > result.maxCpu) result.maxCpu = rec.cpu;
    }
    return result;
  }
}
