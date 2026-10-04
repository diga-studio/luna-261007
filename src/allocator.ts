import type { CalendarSegment, DoctorId, Duration, Minute } from "./types.ts";
import { DURATIONS } from "./types.ts";
import { DoctorSchedule } from "./doctor.ts";

interface Booking {
  doctor: DoctorId;
  start: Minute;
  duration: Duration;
}

function checkDuration(duration: Duration): void {
  if (!DURATIONS.includes(duration)) {
    throw new RangeError(`invalid duration ${duration}; must be 15, 30 or 60`);
  }
}

function checkMinute(value: Minute, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer minute, got ${value}`);
  }
}

/**
 * Public library entry point. Manages any number of doctors; capacities are
 * fully independent between doctors. All calls are synchronous and single
 * threaded.
 */
export class SlotAllocator {
  private doctors = new Map<DoctorId, DoctorSchedule>();
  private bookings = new Map<string, Booking>();
  private nextId = 1;

  /** Install a doctor's immutable open calendar. Each doctor may be set once. */
  setCalendar(doctor: DoctorId, segments: readonly CalendarSegment[]): void {
    if (this.doctors.has(doctor)) {
      throw new Error(`calendar for doctor ${String(doctor)} is already set`);
    }
    this.doctors.set(doctor, new DoctorSchedule(segments));
  }

  private scheduleOf(doctor: DoctorId): DoctorSchedule {
    const schedule = this.doctors.get(doctor);
    if (schedule === undefined) {
      throw new Error(`unknown doctor ${String(doctor)}; call setCalendar first`);
    }
    return schedule;
  }

  /** Earliest bookable start within [queryStart, queryEnd), or null. Does not consume capacity. */
  findEarliest(doctor: DoctorId, queryStart: Minute, queryEnd: Minute, duration: Duration): Minute | null {
    checkMinute(queryStart, "queryStart");
    checkMinute(queryEnd, "queryEnd");
    checkDuration(duration);
    if (queryEnd <= queryStart) return null;
    return this.scheduleOf(doctor).findEarliest(queryStart, queryEnd, duration);
  }

  /**
   * Occupy one unit of capacity over [start, start + duration) for the doctor.
   * Returns a unique booking id on success, or null when capacity is insufficient
   * (in which case nothing is occupied).
   */
  book(doctor: DoctorId, start: Minute, duration: Duration): string | null {
    checkMinute(start, "start");
    checkDuration(duration);
    const schedule = this.scheduleOf(doctor);
    if (schedule.rangeMin(start, start + duration) < 1) {
      return null;
    }
    schedule.apply(start, start + duration, -1);
    const id = `b${this.nextId++}`;
    this.bookings.set(id, { doctor, start, duration });
    return id;
  }

  /** Release exactly the capacity held by the booking. Repeated cancels are no-ops. */
  cancel(bookingId: string): boolean {
    const booking = this.bookings.get(bookingId);
    if (booking === undefined) return false;
    this.bookings.delete(bookingId);
    this.scheduleOf(booking.doctor).apply(booking.start, booking.start + booking.duration, +1);
    return true;
  }
}
