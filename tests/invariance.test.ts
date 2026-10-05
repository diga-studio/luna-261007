import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculatePayRun, type LocalTime, type PayRules, type ShiftRecord } from "../src/index.js";
import { dayNumberToDate, localTimeToAbsMinute } from "../src/time.js";

const PERIOD_START = "2026-10-05"; // 周一

// 最低时薪与班次差异叠加：A/J1 有效时薪 = max(1000, 1050) * 1.0005 = 1050.525 分/小时，
// 每分钟 17.50875 分，产生不足一分的尾数。
const RULES: PayRules = {
  minimumRates: [
    { siteId: "A", jobId: "J1", rateCents: 1050 },
    { siteId: "B", jobId: "J2", rateCents: 1100 },
  ],
  dailyOvertimeEnabled: true,
};

// 周一至周五：A 09:00-13:00，B 13:00-17:30；周六：A 09:00-13:00。
function buildShifts(): ShiftRecord[] {
  const shifts: ShiftRecord[] = [];
  const weekdays = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
  for (const day of weekdays) {
    shifts.push({
      employeeId: "E1",
      siteId: "A",
      jobId: "J1",
      start: { date: day, minute: 9 * 60 },
      end: { date: day, minute: 13 * 60 },
      baseRateCents: 1000,
      shiftDiffBps: 5,
    });
    shifts.push({
      employeeId: "E1",
      siteId: "B",
      jobId: "J2",
      start: { date: day, minute: 13 * 60 },
      end: { date: day, minute: 17 * 60 + 30 },
      baseRateCents: 1200,
      shiftDiffBps: 0,
    });
  }
  shifts.push({
    employeeId: "E1",
    siteId: "A",
    jobId: "J1",
    start: { date: "2026-10-10", minute: 9 * 60 },
    end: { date: "2026-10-10", minute: 13 * 60 },
    baseRateCents: 1000,
    shiftDiffBps: 5,
  });
  return shifts;
}

function absToLocal(absMinute: number): LocalTime {
  const dayNumber = Math.floor(absMinute / 1440);
  return { date: dayNumberToDate(dayNumber), minute: absMinute - dayNumber * 1440 };
}

/** 把每条记录无损拆成至多 pieceMinutes 的碎片。 */
function splitShifts(shifts: ShiftRecord[], pieceMinutes: number): ShiftRecord[] {
  const result: ShiftRecord[] = [];
  for (const shift of shifts) {
    const startAbs = localTimeToAbsMinute(shift.start);
    const endAbs = localTimeToAbsMinute(shift.end);
    for (let cursor = startAbs; cursor < endAbs; cursor += pieceMinutes) {
      result.push({
        ...shift,
        start: absToLocal(cursor),
        end: absToLocal(Math.min(cursor + pieceMinutes, endAbs)),
      });
    }
  }
  return result;
}

/** 确定性洗牌（固定种子），模拟任意输入顺序。 */
function shuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

describe("尾数、打乱与无损拆分下的不变性", () => {
  const baseline = calculatePayRun(PERIOD_START, 1, buildShifts(), RULES);

  it("明确数值期望：混合费率、日加班与周加班", () => {
    const lineA = baseline.lines.find((l) => l.siteId === "A")!;
    const lineB = baseline.lines.find((l) => l.siteId === "B")!;
    // A：周一至周五各 240 分钟常规 + 周六 240 分钟周加班，费率 1050.525 分/小时。
    assert.deepEqual(
      [lineA.regularMinutes, lineA.dailyOvertimeMinutes, lineA.weeklyOvertimeMinutes],
      [1200, 0, 240],
    );
    // B：每天 240 分钟常规 + 30 分钟日加班（17:00-17:30），费率 1200 分/小时。
    assert.deepEqual(
      [lineB.regularMinutes, lineB.dailyOvertimeMinutes, lineB.weeklyOvertimeMinutes],
      [1200, 150, 0],
    );
    // 周基础工资 = 1440*17.50875 + 1350*20 = 25212.6 + 27000 = 52212.6 → 52213。
    // 尾数 0.6 在 A 行，故 A 行分得这一分。
    assert.equal(lineA.basePayCents, 25213);
    assert.equal(lineB.basePayCents, 27000);
    // 每个加班分钟增额 = 52212.6 / (2*2790) ≈ 9.3571 分。
    // A 行 240 分钟 ≈ 2245.70 → 2246；B 行 150 分钟 ≈ 1403.56 → 1403；合计 3649。
    assert.equal(lineA.overtimePremiumCents, 2246);
    assert.equal(lineB.overtimePremiumCents, 1403);
    const total = baseline.totals.find((t) => t.employeeId === "E1")!;
    assert.equal(total.basePayCents, 52213);
    assert.equal(total.overtimePremiumCents, 3649);
  });

  it("打乱输入顺序不改变任何账行与总额", () => {
    for (const seed of [1, 42, 20261006]) {
      const shuffled = calculatePayRun(PERIOD_START, 1, shuffle(buildShifts(), seed), RULES);
      assert.deepEqual(shuffled, baseline);
    }
  });

  it("在日、周阈值前后无损拆分记录，逐行结果保持一致", () => {
    // 37 分钟碎片会落在 480 分钟日阈值与 2400 分钟周阈值前后的任意位置。
    for (const pieceMinutes of [37, 61, 480]) {
      const split = splitShifts(buildShifts(), pieceMinutes);
      const shuffledSplit = calculatePayRun(PERIOD_START, 1, shuffle(split, 7), RULES);
      assert.deepEqual(shuffledSplit, baseline);
    }
  });

  it("所有分钟和分币守恒", () => {
    const total = baseline.totals.find((t) => t.employeeId === "E1")!;
    const sum = (key: "regularMinutes" | "dailyOvertimeMinutes" | "weeklyOvertimeMinutes") =>
      baseline.lines.reduce((acc, l) => acc + l[key], 0);
    assert.equal(sum("regularMinutes"), total.regularMinutes);
    assert.equal(sum("dailyOvertimeMinutes"), total.dailyOvertimeMinutes);
    assert.equal(sum("weeklyOvertimeMinutes"), total.weeklyOvertimeMinutes);
    assert.equal(
      baseline.lines.reduce((acc, l) => acc + l.basePayCents, 0),
      total.basePayCents,
    );
    assert.equal(
      baseline.lines.reduce((acc, l) => acc + l.overtimePremiumCents, 0),
      total.overtimePremiumCents,
    );
    // 每一分钟都且仅归入三类之一。
    assert.equal(
      total.regularMinutes + total.dailyOvertimeMinutes + total.weeklyOvertimeMinutes,
      2790,
    );
  });
});
