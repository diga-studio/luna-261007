import { Treap } from "./treap";

export const WINDOW_MS = 3_600_000;

export interface InputRecord {
  recordId: string;
  revision: number;
  eventTimeMs: number;
  value: number;
}

export interface WindowStats {
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
}

interface LiveRecord {
  revision: number;
  eventTimeMs: number;
  value: number;
}

const MAX_BATCH = 5000;
const MIN_EVENT_TIME_MS = 0;
const MAX_EVENT_TIME_MS = 1_000_000_000_000;
const MIN_VALUE = -1_000_000;
const MAX_VALUE = 1_000_000;

/**
 * Single-pipeline event-time window aggregator shared by realtime sampling
 * and backfill. Keeps only the highest-revision version of each recordId and
 * maintains a (eventTimeMs, recordId) index with subtree aggregates, so both
 * corrections and window queries cost O(log n) per record.
 */
export class WindowAggregator {
  private readonly live = new Map<string, LiveRecord>();
  private readonly index = new Treap();

  upsertBatch(records: InputRecord[]): void {
    if (records.length > MAX_BATCH) {
      throw new RangeError(
        `upsertBatch accepts at most ${MAX_BATCH} records, got ${records.length}`,
      );
    }
    for (const rec of records) {
      this.validate(rec);
      const prev = this.live.get(rec.recordId);
      // Only the highest revision wins; lower or duplicate revisions are
      // no-ops (duplicate revisions are guaranteed identical in content).
      if (prev && prev.revision >= rec.revision) continue;
      if (prev) {
        this.index.remove(prev.eventTimeMs, rec.recordId);
      }
      this.live.set(rec.recordId, {
        revision: rec.revision,
        eventTimeMs: rec.eventTimeMs,
        value: rec.value,
      });
      this.index.insert(rec.eventTimeMs, rec.recordId, rec.value);
    }
  }

  query(endMs: number): WindowStats {
    const stats = this.index.rangeStats(endMs - WINDOW_MS, endMs);
    if (stats.count === 0) {
      return { count: 0, mean: null, min: null, max: null };
    }
    return {
      count: stats.count,
      mean: stats.sum / stats.count,
      min: stats.min,
      max: stats.max,
    };
  }

  /** Number of distinct live recordIds (highest revision only). */
  get size(): number {
    return this.live.size;
  }

  private validate(rec: InputRecord): void {
    if (
      typeof rec.recordId !== "string" ||
      !Number.isInteger(rec.revision) ||
      rec.revision < 0 ||
      !Number.isInteger(rec.eventTimeMs) ||
      rec.eventTimeMs < MIN_EVENT_TIME_MS ||
      rec.eventTimeMs > MAX_EVENT_TIME_MS ||
      !Number.isInteger(rec.value) ||
      rec.value < MIN_VALUE ||
      rec.value > MAX_VALUE
    ) {
      throw new RangeError(`invalid record: ${JSON.stringify(rec)}`);
    }
  }
}
