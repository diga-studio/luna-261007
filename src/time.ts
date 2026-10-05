import type { LocalDate, LocalDateTime } from "./types.js";

const MINUTES_PER_DAY = 1440;
const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 for a local date string, computed in UTC so DST is ignored. */
export function dateToDayNumber(date: LocalDate): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
}

export function dayNumberToDate(dayNumber: number): LocalDate {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Absolute minute index: days since epoch * 1440 + minute-of-day. */
export function toAbsoluteMinute(t: LocalDateTime): number {
  return dateToDayNumber(t.date) * MINUTES_PER_DAY + t.minute;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return dayNumberToDate(dateToDayNumber(date) + days);
}
