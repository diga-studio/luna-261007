import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculatePayRun, type PayRules, type ShiftRecord } from "../src/index.js";

const PERIOD_START = "2026-10-05"; // 周一

// 连续 6 天（周一至周六），每天 08:00-18:00 共 10 小时；
// 每天 13:00 更换工地与费率：A/J1 2000 分，B/J2 3000 分，无班次差异。
function buildShifts(): ShiftRecord[] {
  const shifts: ShiftRecord[] = [];
  const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
  for (const day of days) {
    shifts.push({
      employeeId: "E1",
      siteId: "A",
      jobId: "J1",
      start: { date: day, minute: 8 * 60 },
      end: { date: day, minute: 13 * 60 },
      baseRateCents: 2000,
      shiftDiffBps: 0,
    });
    shifts.push({
      employeeId: "E1",
      siteId: "B",
      jobId: "J2",
      start: { date: day, minute: 13 * 60 },
      end: { date: day, minute: 18 * 60 },
      baseRateCents: 3000,
      shiftDiffBps: 0,
    });
  }
  return shifts;
}

const RULES: PayRules = {
  minimumRates: [
    { siteId: "A", jobId: "J1", rateCents: 1500 },
    { siteId: "B", jobId: "J2", rateCents: 2500 },
  ],
  dailyOvertimeEnabled: true,
};

describe("日加班开启：连续 6 天各 10 小时，同一天更换工地和费率", () => {
  const result = calculatePayRun(PERIOD_START, 1, buildShifts(), RULES);

  it("分钟分类为普通 40h、日加班 12h、周加班 8h", () => {
    const total = result.totals.find((t) => t.employeeId === "E1")!;
    assert.equal(total.regularMinutes, 40 * 60);
    assert.equal(total.dailyOvertimeMinutes, 12 * 60);
    assert.equal(total.weeklyOvertimeMinutes, 8 * 60);
  });

  it("账行分钟按工地拆分正确", () => {
    const lineA = result.lines.find((l) => l.siteId === "A")!;
    const lineB = result.lines.find((l) => l.siteId === "B")!;
    // 每天前 480 分钟（08:00-16:00）进入周累计：A 300 分钟 + B 180 分钟。
    // 周一至周五恰好累计 2400 分钟，周六的 480 分钟全部为周加班。
    // 每天 16:00-18:00 的 120 分钟（全部在 B）为日加班。
    assert.deepEqual(
      [lineA.regularMinutes, lineA.dailyOvertimeMinutes, lineA.weeklyOvertimeMinutes],
      [1500, 0, 300],
    );
    assert.deepEqual(
      [lineB.regularMinutes, lineB.dailyOvertimeMinutes, lineB.weeklyOvertimeMinutes],
      [900, 720, 180],
    );
  });

  it("基础工资按各自费率计算", () => {
    const lineA = result.lines.find((l) => l.siteId === "A")!;
    const lineB = result.lines.find((l) => l.siteId === "B")!;
    assert.equal(lineA.basePayCents, (1800 * 2000) / 60); // 60000
    assert.equal(lineB.basePayCents, (1800 * 3000) / 60); // 90000
  });

  it("加班增额使用全周混合常规时薪，而非所在工地时薪", () => {
    // 周基础工资 150000 分 / 60 小时 = 2500 分/小时；每个加班分钟增额 = 2500*0.5/60。
    // A 行 300 分钟周加班：6250 分；B 行 900 分钟加班：18750 分。
    const lineA = result.lines.find((l) => l.siteId === "A")!;
    const lineB = result.lines.find((l) => l.siteId === "B")!;
    assert.equal(lineA.overtimePremiumCents, 6250);
    assert.equal(lineB.overtimePremiumCents, 18750);
    const total = result.totals.find((t) => t.employeeId === "E1")!;
    assert.equal(total.basePayCents, 150000);
    assert.equal(total.overtimePremiumCents, 25000);
  });

  it("账行金额之和等于员工合计", () => {
    const total = result.totals.find((t) => t.employeeId === "E1")!;
    assert.equal(
      result.lines.reduce((acc, l) => acc + l.basePayCents, 0),
      total.basePayCents,
    );
    assert.equal(
      result.lines.reduce((acc, l) => acc + l.overtimePremiumCents, 0),
      total.overtimePremiumCents,
    );
  });
});
