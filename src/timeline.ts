import type { DatabaseSync } from 'node:sqlite';
import type { OwnershipInterval } from './types.js';

function validateIntervals(intervals: readonly OwnershipInterval[]): void {
  let prevEnd = -Infinity;
  for (const interval of intervals) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)) {
      throw new Error('interval bounds must be finite numbers');
    }
    if (interval.startMs >= interval.endMs) {
      throw new Error(
        `interval start must be < end: [${interval.startMs}, ${interval.endMs})`,
      );
    }
    if (interval.startMs < prevEnd) {
      throw new Error('ownership intervals of one IP must not overlap');
    }
    prevEnd = interval.endMs;
  }
}

/**
 * Replace the full ownership timeline of one IP. Intervals must be sorted by
 * startMs, non-overlapping, [startMs, endMs). Gaps are allowed.
 */
export function replaceTimeline(
  db: DatabaseSync,
  ip: string,
  intervals: readonly OwnershipInterval[],
): void {
  validateIntervals(intervals);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM timelines WHERE ip = ?').run(ip);
    const insert = db.prepare(
      'INSERT INTO timelines (ip, start_ms, end_ms, asset_id) VALUES (?, ?, ?, ?)',
    );
    for (const interval of intervals) {
      insert.run(ip, interval.startMs, interval.endMs, interval.assetId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

interface TimelineRow {
  startMs: number;
  endMs: number;
  assetId: string;
}

/**
 * Resolves IP ownership with a per-IP in-memory cache, so bulk operations
 * (ingest, revision) hit SQLite once per distinct IP instead of per row.
 * Call `invalidate(ip)` after replacing a timeline.
 */
export class TimelineResolver {
  private readonly cache = new Map<string, TimelineRow[]>();

  constructor(private readonly db: DatabaseSync) {}

  invalidate(ip: string): void {
    this.cache.delete(ip);
  }

  resolve(ip: string, atMs: number): string | null {
    let rows = this.cache.get(ip);
    if (rows === undefined) {
      rows = this.db
        .prepare(
          `SELECT start_ms AS startMs, end_ms AS endMs, asset_id AS assetId
           FROM timelines WHERE ip = ? ORDER BY start_ms`,
        )
        .all(ip) as TimelineRow[];
      this.cache.set(ip, rows);
    }
    // Binary search: last interval with startMs <= atMs.
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid]!.startMs <= atMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo === 0) {
      return null;
    }
    const row = rows[lo - 1]!;
    return atMs < row.endMs ? row.assetId : null;
  }
}
