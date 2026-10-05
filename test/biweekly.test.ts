import { test } from "node:test";
import assert from "node:assert/strict";
import { calculatePayRun, type PayLine, type PayRules, type ShiftRecord } from "../src/index.js";

const RULES: PayRules = { minimumRates: [], dailyOvertimeEnabled: true };

// Week 1 starts Mon 2026-10-05, week 2 starts Mon 2026-10-12.
const SHIFTS: ShiftRecord[] = [
  // Crosses midnight inside week 1: Fri 20:00 -> Sat 04:00.
  {
    employeeId: "emp1", siteId: "siteA", jobId: "jobX",
    start: { date: "2026-10-09", minute: 20 * 60 }, end: { date: "2026-10-10", minute: 4 * 60 },
    baseRateCents: 2000, shiftDiffBps: 0,
  },
  // Crosses the week boundary: Sun 22:00 -> Mon 06:00.
  {
    employeeId: "emp1", siteId: "siteA", jobId: "jobX",
    start: { date: "2026-10-11", minute: 22 * 60 }, end: { date: "2026-10-12", minute: 6 * 60 },
    baseRateCents: 2000, shiftDiffBps: 0,
  },
  // Week 2 with a different rate.
  {
    employeeId: "emp1", siteId: "siteB", jobId: "jobY",
    start: { date: "2026-10-12", minute: 8 * 60 }, end: { date: "2026-10-12", minute: 16 * 60 },
    baseRateCents: 2500, shiftDiffBps: 0,
  },
];

function stripWeek(line: PayLine): Omit<PayLine, "weekIndex" | "weekStart"> {
  const { weekIndex: _w, weekStart: _s, ...rest } = line;
  return rest;
}

test("cross-midnight and cross-week shifts: exact per-week amounts", () => {
  const r = calculatePayRun("2026-10-05", 2, SHIFTS, RULES);
  assert.equal(r.lines.length, 3);

  const week1 = r.lines.filter((l) => l.weekIndex === 0);
  const week2 = r.lines.filter((l) => l.weekIndex === 1);

  // Week 1: 8h Fri->Sat plus 2h Sunday, all at $20.00, 600 regular minutes.
  assert.deepEqual(week1.map(stripWeek), [{
    employeeId: "emp1", siteId: "siteA", jobId: "jobX",
    regularMinutes: 600, dailyOtMinutes: 0, weeklyOtMinutes: 0,
    basePayCents: 20_000, overtimePremiumCents: 0,
  }]);
  assert.equal(week1[0]!.weekStart, "2026-10-05");

  // Week 2: 6h at $20.00 (Mon 00:00-06:00) and 8h at $25.00 (Mon 08:00-16:00).
  // Monday already has 360 worked minutes when the second shift starts, so only
  // its first 120 minutes are regular-eligible; the remaining 360 are daily OT.
  assert.deepEqual(week2.map(stripWeek), [
    {
      employeeId: "emp1", siteId: "siteA", jobId: "jobX",
      regularMinutes: 360, dailyOtMinutes: 0, weeklyOtMinutes: 0,
      basePayCents: 12_000, overtimePremiumCents: 0,
    },
    {
      employeeId: "emp1", siteId: "siteB", jobId: "jobY",
      regularMinutes: 120, dailyOtMinutes: 360, weeklyOtMinutes: 0,
      basePayCents: 20_000, overtimePremiumCents: 6857,
    },
  ]);
  assert.equal(week2[0]!.weekStart, "2026-10-12");

  // Week-2 regular rate = $320 / 14h; premium per OT minute = 32000/(2*840) cents,
  // 360 OT minutes -> 6857.1428... -> 6857 cents (exact rational, half-up).
  assert.deepEqual(r.employeeTotals, [{
    employeeId: "emp1",
    regularMinutes: 1080, dailyOtMinutes: 360, weeklyOtMinutes: 0,
    basePayCents: 52_000, overtimePremiumCents: 6857, totalCents: 58_857,
  }]);
});

test("biweekly run equals two independent single-week runs, week by week", () => {
  const bi = calculatePayRun("2026-10-05", 2, SHIFTS, RULES);
  const wk1 = calculatePayRun("2026-10-05", 1, SHIFTS, RULES);
  const wk2 = calculatePayRun("2026-10-12", 1, SHIFTS, RULES);

  assert.deepEqual(
    bi.lines.filter((l) => l.weekIndex === 0).map(stripWeek),
    wk1.lines.map(stripWeek),
  );
  assert.deepEqual(
    bi.lines.filter((l) => l.weekIndex === 1).map(stripWeek),
    wk2.lines.map(stripWeek),
  );
  assert.deepEqual(bi.employeeTotals, [{
    employeeId: "emp1",
    regularMinutes: wk1.employeeTotals[0]!.regularMinutes + wk2.employeeTotals[0]!.regularMinutes,
    dailyOtMinutes: wk1.employeeTotals[0]!.dailyOtMinutes + wk2.employeeTotals[0]!.dailyOtMinutes,
    weeklyOtMinutes: wk1.employeeTotals[0]!.weeklyOtMinutes + wk2.employeeTotals[0]!.weeklyOtMinutes,
    basePayCents: wk1.employeeTotals[0]!.basePayCents + wk2.employeeTotals[0]!.basePayCents,
    overtimePremiumCents:
      wk1.employeeTotals[0]!.overtimePremiumCents + wk2.employeeTotals[0]!.overtimePremiumCents,
    totalCents: wk1.employeeTotals[0]!.totalCents + wk2.employeeTotals[0]!.totalCents,
  }]);
});

test("a week without any work settles to zero and produces no lines", () => {
  const onlyWeek1: ShiftRecord[] = [SHIFTS[0]!];
  const r = calculatePayRun("2026-10-05", 2, onlyWeek1, RULES);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0]!.weekIndex, 0);
  assert.deepEqual(r.employeeTotals, [{
    employeeId: "emp1",
    regularMinutes: 480, dailyOtMinutes: 0, weeklyOtMinutes: 0,
    basePayCents: 16_000, overtimePremiumCents: 0, totalCents: 16_000,
  }]);
});
