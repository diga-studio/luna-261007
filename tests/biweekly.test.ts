import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculatePayRun, type PayLine, type PayRules, type ShiftRecord } from "../src/index.js";

const WEEK1_START = "2026-10-05"; // 周一
const WEEK2_START = "2026-10-12"; // 下一周一

const RULES: PayRules = {
  minimumRates: [],
  dailyOvertimeEnabled: false,
};

// E1：周日 22:00 至周一 02:00 跨周界；周二 20:00 至周三 04:00 跨午夜（第一周，费率 2000）；
// 第二周周二 09:00-17:00 费率变为 2400。E2：仅第二周有工时。
const SHIFTS: ShiftRecord[] = [
  {
    employeeId: "E1",
    siteId: "A",
    jobId: "J1",
    start: { date: "2026-10-11", minute: 22 * 60 },
    end: { date: "2026-10-12", minute: 2 * 60 },
    baseRateCents: 2000,
    shiftDiffBps: 0,
  },
  {
    employeeId: "E1",
    siteId: "A",
    jobId: "J1",
    start: { date: "2026-10-06", minute: 20 * 60 },
    end: { date: "2026-10-07", minute: 4 * 60 },
    baseRateCents: 2000,
    shiftDiffBps: 0,
  },
  {
    employeeId: "E1",
    siteId: "A",
    jobId: "J1",
    start: { date: "2026-10-13", minute: 9 * 60 },
    end: { date: "2026-10-13", minute: 17 * 60 },
    baseRateCents: 2400,
    shiftDiffBps: 0,
  },
  {
    employeeId: "E2",
    siteId: "B",
    jobId: "J2",
    start: { date: "2026-10-14", minute: 8 * 60 },
    end: { date: "2026-10-14", minute: 16 * 60 },
    baseRateCents: 1800,
    shiftDiffBps: 0,
  },
];

function sortedLines(lines: PayLine[]): PayLine[] {
  return [...lines].sort(
    (a, b) =>
      a.employeeId.localeCompare(b.employeeId) ||
      a.weekIndex - b.weekIndex ||
      a.siteId.localeCompare(b.siteId) ||
      a.jobId.localeCompare(b.jobId),
  );
}

describe("双周薪：跨午夜与跨周界，第二周费率变化", () => {
  const biweekly = calculatePayRun(WEEK1_START, 2, SHIFTS, RULES);
  const singleWeek1 = calculatePayRun(WEEK1_START, 1, SHIFTS, RULES);
  const singleWeek2 = calculatePayRun(WEEK2_START, 1, SHIFTS, RULES);

  it("跨周界班次被拆到两周：第一周 120 分钟，第二周 120 分钟", () => {
    const e1Week1 = biweekly.lines.find((l) => l.employeeId === "E1" && l.weekIndex === 0)!;
    const e1Week2 = biweekly.lines.find((l) => l.employeeId === "E1" && l.weekIndex === 1)!;
    // 第一周：周日 120 + 跨午夜 480 = 600 分钟 @2000。
    assert.equal(e1Week1.regularMinutes, 600);
    assert.equal(e1Week1.basePayCents, (600 * 2000) / 60); // 20000
    // 第二周：周一凌晨 120 @2000 + 周二 480 @2400。
    assert.equal(e1Week2.regularMinutes, 600);
    assert.equal(e1Week2.basePayCents, (120 * 2000) / 60 + (480 * 2400) / 60); // 23200
  });

  it("双周结果逐周等于分别核算的两个单周结果", () => {
    const biWeek1 = sortedLines(biweekly.lines.filter((l) => l.weekIndex === 0));
    const biWeek2 = sortedLines(biweekly.lines.filter((l) => l.weekIndex === 1)).map((l) => ({
      ...l,
      weekIndex: 0,
    }));
    assert.deepEqual(biWeek1, sortedLines(singleWeek1.lines));
    assert.deepEqual(biWeek2, sortedLines(singleWeek2.lines));
  });

  it("员工本期合计等于两个单周合计之和", () => {
    for (const employeeId of ["E1", "E2"]) {
      const bi = biweekly.totals.find((t) => t.employeeId === employeeId)!;
      const s1 = singleWeek1.totals.find((t) => t.employeeId === employeeId);
      const s2 = singleWeek2.totals.find((t) => t.employeeId === employeeId);
      assert.equal(bi.basePayCents, (s1?.basePayCents ?? 0) + (s2?.basePayCents ?? 0));
      assert.equal(bi.overtimePremiumCents, (s1?.overtimePremiumCents ?? 0) + (s2?.overtimePremiumCents ?? 0));
      assert.equal(bi.regularMinutes, (s1?.regularMinutes ?? 0) + (s2?.regularMinutes ?? 0));
    }
  });

  it("无工时的周金额为零且不产生账行", () => {
    assert.equal(singleWeek1.totals.find((t) => t.employeeId === "E2"), undefined);
    assert.equal(biweekly.lines.filter((l) => l.employeeId === "E2").length, 1);
    const e2 = biweekly.totals.find((t) => t.employeeId === "E2")!;
    assert.equal(e2.basePayCents, (480 * 1800) / 60); // 14400
    assert.equal(e2.overtimePremiumCents, 0);
  });
});
