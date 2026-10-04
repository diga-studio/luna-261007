/** Minutes since Unix epoch. All ranges are [start, end): start inclusive, end exclusive. */
export type Minute = number;

export type DoctorId = string | number;

/** Allowed appointment durations in minutes. */
export type Duration = 15 | 30 | 60;

export const DURATIONS: readonly Duration[] = [15, 30, 60];

/** One open-calendar segment. Capacity is 1..8. Segments never overlap. */
export interface CalendarSegment {
  readonly start: Minute;
  readonly end: Minute;
  readonly capacity: number;
}

/** Result of an earliest-slot query: a start minute, or null when no slot fits. */
export type QueryResult = Minute | null;
