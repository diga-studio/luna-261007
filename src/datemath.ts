/** Parsed Gregorian calendar day. */
export interface CalDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

const ISO_DATE_RE = /^(\d{4,})-(\d{2})-(\d{2})$/;

export function parseISODate(text: string): CalDate {
  const match = ISO_DATE_RE.exec(text);
  if (match === null) {
    throw new RangeError(`invalid ISO date: ${JSON.stringify(text)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`invalid calendar date: ${JSON.stringify(text)}`);
  }
  return { year, month, day };
}

export function formatISODate(date: CalDate): string {
  const y = String(date.year).padStart(4, "0");
  const m = String(date.month).padStart(2, "0");
  const d = String(date.day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Number of days in the given Gregorian month. */
export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new RangeError(`invalid month: ${month}`);
  }
}

/**
 * Adds `months` months to the date, keeping the original day-of-month;
 * if the target month lacks that day, clamps to the month's last day.
 * The clamped result is never carried into subsequent additions.
 */
export function addMonthsClamped(date: CalDate, months: number): CalDate {
  if (!Number.isInteger(months) || months < 0) {
    throw new RangeError(`months must be a non-negative integer: ${months}`);
  }
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return { year, month, day };
}

/** Total ordering on calendar days: negative/zero/positive like a comparator. */
export function compareDates(a: CalDate, b: CalDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}
