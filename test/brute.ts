/**
 * Independent per-minute reference implementation used to cross-check the
 * optimized allocator. Deliberately naive: scans minute by minute.
 */

import type { CalendarSegment, Duration } from "../src/allocator";

interface BruteBooking {
  start: number;
  duration: Duration;
  active: boolean;
}

class BruteDoctor {
  readonly segments: CalendarSegment[];
  readonly bookings: BruteBooking[] = [];

  constructor(segments: readonly CalendarSegment[]) {
    this.segments = [...segments].sort((a, b) => a.start - b.start);
  }

  capacityAt(minute: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = this.segments[mid] as CalendarSegment;
      if (minute < seg.start) hi = mid - 1;
      else if (minute >= seg.end) lo = mid + 1;
      else return seg.capacity;
    }
    return 0;
  }

  occupiedAt(minute: number): number {
    let count = 0;
    for (const booking of this.bookings) {
      if (
        booking.active &&
        minute >= booking.start &&
        minute < booking.start + booking.duration
      ) {
        count += 1;
      }
    }
    return count;
  }

  isAvailable(start: number, duration: Duration): boolean {
    for (let m = start; m < start + duration; m++) {
      if (this.occupiedAt(m) >= this.capacityAt(m)) return false;
    }
    return true;
  }

  findEarliest(queryStart: number, queryEnd: number, duration: Duration): number | null {
    for (let s = queryStart; s + duration <= queryEnd; s++) {
      if (this.isAvailable(s, duration)) return s;
    }
    return null;
  }
}

export class BruteForce {
  private readonly doctors = new Map<string, BruteDoctor>();
  private readonly bookings = new Map<string, { doctorId: string; index: number }>();
  private seq = 0;

  addDoctor(doctorId: string, segments: readonly CalendarSegment[]): void {
    this.doctors.set(doctorId, new BruteDoctor(segments));
  }

  findEarliest(
    doctorId: string,
    queryStart: number,
    queryEnd: number,
    duration: Duration,
  ): number | null {
    if (queryEnd - queryStart < duration) return null;
    return (this.doctors.get(doctorId) as BruteDoctor).findEarliest(
      queryStart,
      queryEnd,
      duration,
    );
  }

  book(doctorId: string, start: number, duration: Duration): string | null {
    const doctor = this.doctors.get(doctorId) as BruteDoctor;
    if (!doctor.isAvailable(start, duration)) return null;
    const id = `x${this.seq}`;
    this.seq += 1;
    this.bookings.set(id, { doctorId, index: doctor.bookings.length });
    doctor.bookings.push({ start, duration, active: true });
    return id;
  }

  cancel(id: string): boolean {
    const ref = this.bookings.get(id);
    if (ref === undefined) return false;
    const doctor = this.doctors.get(ref.doctorId) as BruteDoctor;
    const booking = doctor.bookings[ref.index];
    if (booking === undefined || !booking.active) return false;
    booking.active = false;
    return true;
  }
}
