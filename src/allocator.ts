/**
 * In-memory continuous slot allocator for outpatient appointments.
 *
 * All times are integer minutes since the Unix epoch. Ranges are
 * [start, end): inclusive of start, exclusive of end.
 *
 * Per doctor the allocator keeps three ordered structures over minute
 * boundaries, all backed by treaps:
 *  - runs:  disjoint intervals with constant remaining capacity.
 *  - good:  maximal intervals where every minute has remaining >= 1.
 *  - long:  per supported duration, the good intervals long enough to
 *           host that duration (this is what makes earliest-slot queries
 *           O(log n) instead of scanning short gaps).
 */

import { TreapMap } from "./treap";

/** Allowed appointment durations in minutes. */
export type Duration = 15 | 30 | 60;

export const DURATIONS: readonly Duration[] = [15, 30, 60];

/** One open-calendar segment; capacity is an integer in [1, 8]. */
export interface CalendarSegment {
  readonly start: number;
  readonly end: number;
  readonly capacity: number;
}

/** Public handle returned by a successful booking. */
export type BookingId = string;

interface BookingRecord {
  doctorId: string;
  start: number;
  duration: Duration;
  active: boolean;
}

interface RunValue {
  /** End minute (exclusive) of this constant-capacity run. */
  end: number;
  /** Remaining capacity on every minute of [start, end). */
  remaining: number;
}

interface IntervalValue {
  /** End minute (exclusive) of the interval starting at the entry key. */
  end: number;
}

function isValidDuration(duration: number): duration is Duration {
  return duration === 15 || duration === 30 || duration === 60;
}

function assertMinute(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer minute, got ${value}`);
  }
}

/**
 * Per-doctor state. All treaps are keyed by interval start minute.
 */
class DoctorState {
  private readonly runs = new TreapMap<RunValue>();
  private readonly good = new TreapMap<IntervalValue>();
  private readonly long = new Map<Duration, TreapMap<IntervalValue>>();

  constructor(segments: readonly CalendarSegment[]) {
    for (const duration of DURATIONS) {
      this.long.set(duration, new TreapMap<IntervalValue>());
    }
    for (const segment of segments) {
      this.runs.set(segment.start, {
        end: segment.end,
        remaining: segment.capacity,
      });
      this.addGoodInterval(segment.start, segment.end);
    }
  }

  /** Insert [start, end) into the long-set of each duration it can host. */
  private syncLong(start: number, end: number): void {
    const length = end - start;
    for (const duration of DURATIONS) {
      const map = this.long.get(duration) as TreapMap<IntervalValue>;
      if (length >= duration) {
        map.set(start, { end });
      } else {
        map.delete(start);
      }
    }
  }

  /**
   * Mark [start, end) as good (remaining >= 1). The interval must currently
   * be entirely non-good. Merges with touching good intervals.
   */
  private addGoodInterval(start: number, end: number): void {
    const left = this.good.floor(start);
    if (left !== undefined && left.value.end === start) {
      this.good.delete(left.key);
      this.removeFromLong(left.key);
      start = left.key;
    }
    const right = this.good.get(end);
    if (right !== undefined) {
      this.good.delete(end);
      this.removeFromLong(end);
      end = right.end;
    }
    this.good.set(start, { end });
    this.syncLong(start, end);
  }

  /**
   * Mark [start, end) as no longer good. The interval must be entirely
   * covered by a single existing good interval.
   */
  private removeGoodInterval(start: number, end: number): void {
    const entry = this.good.floor(start);
    if (entry === undefined || entry.value.end < end) {
      throw new Error("internal error: removeGoodInterval on non-good range");
    }
    const u = entry.key;
    const v = entry.value.end;
    this.good.delete(u);
    this.removeFromLong(u);
    if (u < start) {
      this.good.set(u, { end: start });
      this.syncLong(u, start);
    }
    if (end < v) {
      this.good.set(end, { end: v });
      this.syncLong(end, v);
    }
  }

  private removeFromLong(start: number): void {
    for (const duration of DURATIONS) {
      (this.long.get(duration) as TreapMap<IntervalValue>).delete(start);
    }
  }

  /** Ensure a run boundary exists exactly at minute `at`. */
  private splitRunAt(at: number): void {
    const entry = this.runs.floor(at);
    if (entry === undefined) return;
    if (entry.key === at || entry.value.end <= at) return;
    const value = entry.value;
    this.runs.set(entry.key, { end: at, remaining: value.remaining });
    this.runs.set(at, { end: value.end, remaining: value.remaining });
  }

  /** Whether every minute of [start, end) has remaining capacity >= 1. */
  isAvailable(start: number, end: number): boolean {
    const entry = this.good.floor(start);
    return entry !== undefined && entry.value.end >= end;
  }

  /**
   * Earliest start >= queryStart such that [start, start + duration) is
   * fully available, or null. Caller guarantees the query range can host
   * the duration.
   */
  findEarliest(queryStart: number, queryEnd: number, duration: Duration): number | null {
    const map = this.long.get(duration) as TreapMap<IntervalValue>;
    const needEnd = queryStart + duration;
    const containing = map.floor(queryStart);
    let candidate: number | null = null;
    if (containing !== undefined && containing.value.end >= needEnd) {
      candidate = queryStart;
    } else {
      const next = map.lowerBound(queryStart + 1);
      if (next !== undefined) {
        candidate = next.key;
      }
    }
    if (candidate === null || candidate + duration > queryEnd) {
      return null;
    }
    return candidate;
  }

  /** Decrement remaining capacity over [start, start + duration). */
  occupy(start: number, duration: Duration): void {
    const end = start + duration;
    this.splitRunAt(start);
    this.splitRunAt(end);
    const affected = this.runs.collectRange(start, end, []);
    for (const run of affected) {
      run.value.remaining -= 1;
      if (run.value.remaining === 0) {
        this.removeGoodInterval(run.key, run.value.end);
      }
    }
  }

  /** Increment remaining capacity over [start, start + duration). */
  release(start: number, duration: Duration): void {
    const end = start + duration;
    this.splitRunAt(start);
    this.splitRunAt(end);
    const affected = this.runs.collectRange(start, end, []);
    for (const run of affected) {
      run.value.remaining += 1;
      if (run.value.remaining === 1) {
        this.addGoodInterval(run.key, run.value.end);
      }
    }
  }
}

export class SlotAllocator {
  private readonly doctors = new Map<string, DoctorState>();
  private readonly bookings = new Map<BookingId, BookingRecord>();
  private nextBookingSeq = 0;

  /**
   * Register a doctor with a fixed open calendar. Segments must be
   * non-overlapping (they may touch) with capacity in [1, 8].
   * The calendar never changes afterwards. Throws on duplicate doctor id
   * or invalid input.
   */
  addDoctor(doctorId: string, segments: readonly CalendarSegment[]): void {
    if (typeof doctorId !== "string" || doctorId.length === 0) {
      throw new Error("doctorId must be a non-empty string");
    }
    if (this.doctors.has(doctorId)) {
      throw new Error(`doctor already registered: ${doctorId}`);
    }
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    let previousEnd = -1;
    for (const segment of sorted) {
      assertMinute(segment.start, "segment.start");
      assertMinute(segment.end, "segment.end");
      if (segment.start >= segment.end) {
        throw new Error(`segment start must be < end: [${segment.start}, ${segment.end})`);
      }
      if (segment.start < previousEnd) {
        throw new Error(`overlapping calendar segments for doctor ${doctorId}`);
      }
      if (!Number.isInteger(segment.capacity) || segment.capacity < 1 || segment.capacity > 8) {
        throw new Error(`capacity must be an integer in [1, 8], got ${segment.capacity}`);
      }
      previousEnd = segment.end;
    }
    this.doctors.set(doctorId, new DoctorState(sorted));
  }

  private doctor(doctorId: string): DoctorState {
    const state = this.doctors.get(doctorId);
    if (state === undefined) {
      throw new Error(`unknown doctor: ${doctorId}`);
    }
    return state;
  }

  /**
   * Earliest start time within [queryStart, queryEnd) that can host an
   * appointment of `duration` minutes end-to-end, or null if none.
   * Does not consume capacity.
   */
  findEarliest(
    doctorId: string,
    queryStart: number,
    queryEnd: number,
    duration: Duration,
  ): number | null {
    const state = this.doctor(doctorId);
    assertMinute(queryStart, "queryStart");
    assertMinute(queryEnd, "queryEnd");
    if (!isValidDuration(duration)) {
      throw new Error(`duration must be 15, 30 or 60, got ${duration}`);
    }
    if (queryEnd < queryStart) {
      throw new Error(`queryEnd ${queryEnd} is before queryStart ${queryStart}`);
    }
    if (queryEnd - queryStart < duration) {
      return null;
    }
    return state.findEarliest(queryStart, queryEnd, duration);
  }

  /**
   * Occupy [start, start + duration) for `doctorId`. Succeeds only if every
   * minute of the interval has remaining capacity; on failure nothing is
   * occupied and null is returned. On success returns a unique booking id.
   */
  book(doctorId: string, start: number, duration: Duration): BookingId | null {
    const state = this.doctor(doctorId);
    assertMinute(start, "start");
    if (!isValidDuration(duration)) {
      throw new Error(`duration must be 15, 30 or 60, got ${duration}`);
    }
    if (!state.isAvailable(start, start + duration)) {
      return null;
    }
    state.occupy(start, duration);
    const id: BookingId = `b${this.nextBookingSeq}`;
    this.nextBookingSeq += 1;
    this.bookings.set(id, { doctorId, start, duration, active: true });
    return id;
  }

  /**
   * Release the capacity held by `bookingId`. Returns false (without any
   * effect) for unknown or already-cancelled bookings.
   */
  cancel(bookingId: BookingId): boolean {
    const record = this.bookings.get(bookingId);
    if (record === undefined || !record.active) {
      return false;
    }
    record.active = false;
    // The doctor is guaranteed to exist: bookings are only created for
    // registered doctors and doctors are never removed.
    (this.doctors.get(record.doctorId) as DoctorState).release(
      record.start,
      record.duration,
    );
    return true;
  }
}
