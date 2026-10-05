import { test } from "node:test";
import assert from "node:assert/strict";
import { calculatePayRun, type ShiftRecord } from "../src/index.js";

// Mon 2026-10-05 .. Sat 2026-10-10, 10h per day split across two sites/rates.
// Per day: 08:00-14:00 site A @ $20.00, 14:00-18:00 site B @ $30.00.
// Daily OT (>8h): last 2h of each day (site B). Weekly OT (>40h of non-daily-OT):
// all 8 non-daily-OT hours of day 6 (6h site A + 2h site B).
function makeShifts(): ShiftRecord[] {
  const shifts: ShiftRecord[] = [];
  const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
  for (const d of days) {
    shifts.push({
      employeeId: "emp1", siteId: "siteA", jobId: "jobX",
      start: { date: d, minute: 8 * 60 }, end: { date: d, minute: 14 * 60 },
      baseRateCents: 2000, shiftDiffBps: 0,
    });
    shifts.push({
      employeeId: "emp1", siteId: "siteB", jobId: "jobY",
      start: { date: d, minute: 14 * 60 }, end: { date: d, minute: 18 * 60 },
      baseRateCents: 3000, shiftDiffBps: 0,
    });
  }
  return shifts;
}

test("daily OT on, 6x10h across two sites: 40h regular, 12h daily OT, 8h weekly OT", () => {
  const r = calculatePayRun("2026-10-05", 1, makeShifts(), {
    minimumRates: [],
    dailyOvertimeEnabled: true,
  });

  assert.equal(r.lines.length, 2);
  const [lineA, lineB] = r.lines;
  assert.deepEqual(
    { site: lineA!.siteId, reg: lineA!.regularMinutes, dot: lineA!.dailyOtMinutes, wot: lineA!.weeklyOtMinutes },
    { site: "siteA", reg: 1800, dot: 0, wot: 360 },
  );
  assert.deepEqual(
    { site: lineB!.siteId, reg: lineB!.regularMinutes, dot: lineB!.dailyOtMinutes, wot: lineB!.weeklyOtMinutes },
    { site: "siteB", reg: 600, dot: 720, wot: 120 },
  );

  // Base pay: every worked minute at its own rate.
  // siteA: 6 days * 6h * $20 = $720; siteB: 6 days * 4h * $30 = $720.
  assert.equal(lineA!.basePayCents, 72_000);
  assert.equal(lineB!.basePayCents, 72_000);

  // Weekly regular rate = $1440 / 60h = $24.00/h -> premium $0.20 per OT minute,
  // regardless of which site the OT minute happened at.
  assert.equal(lineA!.overtimePremiumCents, 360 * 20);
  assert.equal(lineB!.overtimePremiumCents, 840 * 20);

  assert.deepEqual(r.employeeTotals, [{
    employeeId: "emp1",
    regularMinutes: 2400,
    dailyOtMinutes: 720,
    weeklyOtMinutes: 480,
    basePayCents: 144_000,
    overtimePremiumCents: 24_000,
    totalCents: 168_000,
  }]);
});
