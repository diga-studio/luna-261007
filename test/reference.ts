import type { CalendarSegment, DoctorId, Duration, Minute } from "../src/types.ts";

interface RefBooking {
  doctor: DoctorId;
  start: Minute;
  duration: Duration;
  active: boolean;
}

/**
 * Independent naive implementation used to cross-check the real library.
 * Computes capacity and occupancy minute by minute; only suitable for
 * short timelines.
 */
export class ReferenceAllocator {
  private calendars = new Map<DoctorId, CalendarSegment[]>();
  private bookings = new Map<string, RefBooking>();
  private nextId = 1;

  setCalendar(doctor: DoctorId, segments: readonly CalendarSegment[]): void {
    this.calendars.set(doctor, segments.map((s) => ({ ...s })));
  }

  private capacityAt(doctor: DoctorId, m: Minute): number {
    for (const seg of this.calendars.get(doctor) ?? []) {
      if (m >= seg.start && m < seg.end) return seg.capacity;
    }
    return 0;
  }

  private occupancyAt(doctor: DoctorId, m: Minute): number {
    let n = 0;
    for (const b of this.bookings.values()) {
      if (b.active && b.doctor === doctor && m >= b.start && m < b.start + b.duration) n++;
    }
    return n;
  }

  private fits(doctor: DoctorId, start: Minute, duration: Duration): boolean {
    for (let m = start; m < start + duration; m++) {
      if (this.occupancyAt(doctor, m) >= this.capacityAt(doctor, m)) return false;
    }
    return true;
  }

  findEarliest(doctor: DoctorId, qs: Minute, qe: Minute, duration: Duration): Minute | null {
    for (let t = qs; t + duration <= qe; t++) {
      if (this.fits(doctor, t, duration)) return t;
    }
    return null;
  }

  book(doctor: DoctorId, start: Minute, duration: Duration): string | null {
    if (!this.fits(doctor, start, duration)) return null;
    const id = `r${this.nextId++}`;
    this.bookings.set(id, { doctor, start, duration, active: true });
    return id;
  }

  cancel(bookingId: string): boolean {
    const b = this.bookings.get(bookingId);
    if (!b || !b.active) return false;
    b.active = false;
    return true;
  }
}
