import { SampleRecord, WindowStats, WINDOW_LENGTH_MS } from './types';
import { TimestampIndex } from './treap';

const MAX_BATCH_SIZE = 5000;
const MIN_EVENT_TIME_MS = 0;
const MAX_EVENT_TIME_MS = 1_000_000_000_000;
const MIN_VALUE = -1_000_000;
const MAX_VALUE = 1_000_000;

interface EffectiveRecord {
  readonly revision: number;
  readonly eventTimeMs: number;
  readonly value: number;
}

/**
 * ForgeLink single-pipeline event-time window aggregator.
 *
 * Shared by realtime sampling and historical backfill. In-process and
 * in-memory only: calls are executed sequentially by the embedding pipeline,
 * nothing is persisted.
 *
 * State kept per distinct recordId: only the highest-revision record. Lower
 * or duplicate revisions never mutate state. Corrections move the record's
 * contribution between timestamps, so window statistics migrate with it.
 */
export class WindowAggregator {
  private readonly effective = new Map<string, EffectiveRecord>();
  private readonly index = new TimestampIndex();

  /**
   * Apply up to 5000 inserts/corrections. Records may arrive in any order,
   * both within a batch and across batches (revision and event time alike).
   */
  upsertBatch(records: readonly SampleRecord[]): void {
    if (records.length > MAX_BATCH_SIZE) {
      throw new RangeError(`batch too large: ${records.length} > ${MAX_BATCH_SIZE}`);
    }
    for (const record of records) {
      validateRecord(record);
      const current = this.effective.get(record.recordId);
      if (current !== undefined && record.revision <= current.revision) {
        // Duplicate or stale revision: must not change state.
        continue;
      }
      if (current !== undefined) {
        this.index.remove(current.eventTimeMs, record.recordId);
      }
      this.index.add(record.eventTimeMs, record.recordId, record.value);
      this.effective.set(record.recordId, {
        revision: record.revision,
        eventTimeMs: record.eventTimeMs,
        value: record.value,
      });
    }
  }

  /**
   * Statistics for the fixed 3600s window (endMs - 3_600_000, endMs].
   * Reflects every completed write exactly once per recordId; later backfill
   * can change the result of re-querying the same endMs.
   */
  query(endMs: number): WindowStats {
    if (!Number.isSafeInteger(endMs)) {
      throw new TypeError(`endMs must be a safe integer, got ${endMs}`);
    }
    const aggregates = this.index.queryRange(endMs - WINDOW_LENGTH_MS, endMs);
    if (aggregates.count === 0) {
      return { count: 0, mean: null, min: null, max: null };
    }
    return {
      count: aggregates.count,
      mean: aggregates.sum / aggregates.count,
      min: aggregates.min,
      max: aggregates.max,
    };
  }

  /** Number of distinct recordIds currently tracked. */
  get recordCount(): number {
    return this.effective.size;
  }
}

function validateRecord(record: SampleRecord): void {
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new TypeError(`revision must be a non-negative integer, got ${record.revision}`);
  }
  if (
    !Number.isSafeInteger(record.eventTimeMs) ||
    record.eventTimeMs < MIN_EVENT_TIME_MS ||
    record.eventTimeMs > MAX_EVENT_TIME_MS
  ) {
    throw new RangeError(`eventTimeMs out of range: ${record.eventTimeMs}`);
  }
  if (
    !Number.isSafeInteger(record.value) ||
    record.value < MIN_VALUE ||
    record.value > MAX_VALUE
  ) {
    throw new RangeError(`value out of range: ${record.value}`);
  }
}

export { SampleRecord, WindowStats, WINDOW_LENGTH_MS };
