import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculatePayRun,
  type PayRunResult,
  type PayRules,
  type ShiftRecord,
} from "../src/index.js";

// Minimum rate ($10.01) beats the base rate ($10.00), then a 0.33% shift
// differential applies on top: effective rate = 1001 * 1.0033 = 1004.3033 cents/h,
// i.e. a sub-cent fraction per minute. Site B pays a flat $15.00.
const RULES: PayRules = {
  minimumRates: [{ siteId: "siteA", jobId: "jobX", rateCents: 1001 }],
  dailyOvertimeEnabled: true,
};

const DAYS = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];

function baseShifts(): ShiftRecord[] {
  const shifts: ShiftRecord[] = [];
  for (const d of DAYS) {
    shifts.push({
      employeeId: "emp1", siteId: "siteA", jobId: "jobX",
      start: { date: d, minute: 8 * 60 }, end: { date: d, minute: 13 * 60 },
      baseRateCents: 1000, shiftDiffBps: 33,
    });
    shifts.push({
      employeeId: "emp1", siteId: "siteB", jobId: "jobY",
      start: { date: d, minute: 13 * 60 }, end: { date: d, minute: 17 * 60 },
      baseRateCents: 1500, shiftDiffBps: 0,
    });
  }
  return shifts;
}

/** Losslessly splits one record at the given absolute minute-of-day offsets. */
function splitShift(shift: ShiftRecord, atMinutes: number[]): ShiftRecord[] {
  const cuts = [...new Set(atMinutes)]
    .filter((m) => m > shift.start.minute && m < shift.end.minute)
    .sort((a, b) => a - b);
  const bounds = [shift.start.minute, ...cuts, shift.end.minute];
  const pieces: ShiftRecord[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    pieces.push({
      ...shift,
      start: { date: shift.start.date, minute: bounds[i]! },
      end: { date: shift.start.date, minute: bounds[i + 1]! },
    });
  }
  return pieces;
}

/** Same work, but records are split around the daily/weekly thresholds and shuffled. */
function splitAndShuffledShifts(): ShiftRecord[] {
  const pieces: ShiftRecord[] = [];
  for (const shift of baseShifts()) {
    const isSaturday = shift.start.date === "2026-10-10";
    // Daily OT threshold on every day is 480 worked minutes = 16:00.
    // The weekly OT threshold is crossed at Saturday 08:00 (first minute of day 6).
    const cuts = isSaturday ? [8 * 60 + 1, 15 * 60 + 59, 16 * 60, 16 * 60 + 1] : [15 * 60 + 59, 16 * 60, 16 * 60 + 1];
    pieces.push(...splitShift(shift, cuts));
  }
  // Deterministic shuffle: interleave from both ends.
  const out: ShiftRecord[] = [];
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo <= hi) {
    out.push(pieces[lo]!);
    if (hi !== lo) out.push(pieces[hi]!);
    lo++;
    hi--;
  }
  return out;
}

const EXPECTED_LINES = [
  {
    employeeId: "emp1", weekIndex: 0, weekStart: "2026-10-05", siteId: "siteA", jobId: "jobX",
    regularMinutes: 1500, dailyOtMinutes: 0, weeklyOtMinutes: 300,
    basePayCents: 30_129, overtimePremiumCents: 3061,
  },
  {
    employeeId: "emp1", weekIndex: 0, weekStart: "2026-10-05", siteId: "siteB", jobId: "jobY",
    regularMinutes: 900, dailyOtMinutes: 360, weeklyOtMinutes: 180,
    basePayCents: 36_000, overtimePremiumCents: 5511,
  },
];

const EXPECTED_TOTAL = {
  employeeId: "emp1",
  regularMinutes: 2400, dailyOtMinutes: 360, weeklyOtMinutes: 480,
  basePayCents: 66_129, overtimePremiumCents: 8572, totalCents: 74_701,
};

test("minimum rate stacked with shift differential: exact fractional expectations", () => {
  const r = calculatePayRun("2026-10-05", 1, baseShifts(), RULES);
  // Site A unrounded base = 1800 min * 1004.3033 c/h = 30129.099c -> 30129.
  // Week base = 66129.099c -> 66129; premium = 840 * base / (2*3240) = 8572.29c -> 8572.
  // Premium split by largest remainder: A 3061 (frac .53), B 5511 (frac .76, rounded up).
  assert.deepEqual(r.lines, EXPECTED_LINES);
  assert.deepEqual(r.employeeTotals, [EXPECTED_TOTAL]);
});

test("lossless splitting around thresholds and shuffling change nothing", () => {
  const plain = calculatePayRun("2026-10-05", 1, baseShifts(), RULES);
  const mangled = calculatePayRun("2026-10-05", 1, splitAndShuffledShifts(), RULES);
  const reversed = calculatePayRun("2026-10-05", 1, [...baseShifts()].reverse(), RULES);
  assert.deepEqual(mangled, plain);
  assert.deepEqual(reversed, plain);
});

test("minutes and cents are conserved across lines, weeks and totals", () => {
  const r: PayRunResult = calculatePayRun("2026-10-05", 1, splitAndShuffledShifts(), RULES);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  // Every worked minute is in exactly one class.
  for (const line of r.lines) {
    // 6 days * 9h = 3240 minutes total across the two lines.
    assert.ok(line.regularMinutes + line.dailyOtMinutes + line.weeklyOtMinutes > 0);
  }
  assert.equal(sum(r.lines.map((l) => l.regularMinutes + l.dailyOtMinutes + l.weeklyOtMinutes)), 3240);

  // Line amounts add up to the employee totals.
  const t = r.employeeTotals[0]!;
  assert.equal(sum(r.lines.map((l) => l.regularMinutes)), t.regularMinutes);
  assert.equal(sum(r.lines.map((l) => l.dailyOtMinutes)), t.dailyOtMinutes);
  assert.equal(sum(r.lines.map((l) => l.weeklyOtMinutes)), t.weeklyOtMinutes);
  assert.equal(sum(r.lines.map((l) => l.basePayCents)), t.basePayCents);
  assert.equal(sum(r.lines.map((l) => l.overtimePremiumCents)), t.overtimePremiumCents);
  assert.equal(t.basePayCents + t.overtimePremiumCents, t.totalCents);

  // Each line's rounded amount is within 1 cent of its exact unrounded value.
  // Site A: 1800 min at numerator 1001*10033 per hour; site B: 1440 min at 1500*10000.
  const exactBaseNum = new Map([
    ["siteA", 1800n * 1001n * 10033n],
    ["siteB", 1440n * 1500n * 10000n],
  ]);
  for (const line of r.lines) {
    const num = exactBaseNum.get(line.siteId)!;
    const diff = BigInt(line.basePayCents) * 600_000n - num;
    assert.ok(diff > -600_000n && diff < 600_000n, `line ${line.siteId} base within 1 cent`);
  }
});
