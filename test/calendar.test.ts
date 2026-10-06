import { describe, expect, it } from "vitest";
import {
  civilFromDays,
  daysFromCivil,
  fallBackDay,
  localToUtcMinutes,
  LocalKind,
  serialDayToDateString,
  springForwardDay,
  utcMinutesToIsoString,
  weekdayOf,
} from "../src/calendar.js";

describe("calendar", () => {
  it("公历往返换算一致", () => {
    for (const [y, m, d] of [
      [2008, 1, 1],
      [2008, 2, 29],
      [2024, 2, 29],
      [2026, 10, 6],
      [9999, 12, 31],
      [2100, 3, 1],
    ] as const) {
      const z = daysFromCivil(y, m, d);
      expect(civilFromDays(z)).toEqual([y, m, d]);
      expect(serialDayToDateString(z)).toBe(
        `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      );
    }
  });

  it("星期几与已知日期一致", () => {
    expect(weekdayOf(daysFromCivil(1970, 1, 1))).toBe(3); // 周四
    expect(weekdayOf(daysFromCivil(2026, 10, 5))).toBe(0); // 周一
    expect(weekdayOf(daysFromCivil(2026, 10, 6))).toBe(1); // 次日周二
  });

  it("DST 转换日：3 月第二个星期日 / 11 月第一个星期日", () => {
    expect(serialDayToDateString(springForwardDay(2026))).toBe("2026-03-08");
    expect(serialDayToDateString(fallBackDay(2026))).toBe("2026-11-01");
    expect(serialDayToDateString(springForwardDay(2008))).toBe("2008-03-09");
    expect(serialDayToDateString(fallBackDay(2008))).toBe("2008-11-02");
    expect(serialDayToDateString(springForwardDay(9999))).toBe("9999-03-14");
    expect(serialDayToDateString(fallBackDay(9999))).toBe("9999-11-07");
  });

  it("标准时与夏令时偏移", () => {
    // 2026-01-15 12:00 标准时 -> 18:00 UTC
    expect(localToUtcMinutes(daysFromCivil(2026, 1, 15), 720, LocalKind.Open)).toBe(
      daysFromCivil(2026, 1, 15) * 1440 + 1080,
    );
    // 2026-07-15 12:00 夏令时 -> 17:00 UTC
    expect(localToUtcMinutes(daysFromCivil(2026, 7, 15), 720, LocalKind.Open)).toBe(
      daysFromCivil(2026, 7, 15) * 1440 + 1020,
    );
  });

  it("春季不存在时刻返回 null", () => {
    const spring = springForwardDay(2026);
    expect(localToUtcMinutes(spring, 119, LocalKind.Open)).not.toBeNull();
    expect(localToUtcMinutes(spring, 120, LocalKind.Open)).toBeNull();
    expect(localToUtcMinutes(spring, 179, LocalKind.Close)).toBeNull();
    expect(localToUtcMinutes(spring, 180, LocalKind.Open)).not.toBeNull();
    // 03:00 CDT = 08:00 UTC
    expect(localToUtcMinutes(spring, 180, LocalKind.Open)).toBe(spring * 1440 + 480);
  });

  it("秋季重复时刻：开放取较早、截止取较晚", () => {
    const fall = fallBackDay(2026);
    // 01:30 开放 -> CDT -> 06:30 UTC；截止 -> CST -> 07:30 UTC
    expect(localToUtcMinutes(fall, 90, LocalKind.Open)).toBe(fall * 1440 + 390);
    expect(localToUtcMinutes(fall, 90, LocalKind.Close)).toBe(fall * 1440 + 450);
    // 00:30 不重复，CDT
    expect(localToUtcMinutes(fall, 30, LocalKind.Open)).toBe(fall * 1440 + 330);
    // 02:00 起标准时
    expect(localToUtcMinutes(fall, 120, LocalKind.Open)).toBe(fall * 1440 + 480);
  });

  it("Unix 分钟转 ISO", () => {
    expect(utcMinutesToIsoString(0)).toBe("1970-01-01T00:00:00Z");
    expect(utcMinutesToIsoString(daysFromCivil(9999, 12, 31) * 1440 + 1439)).toBe(
      "9999-12-31T23:59:00Z",
    );
  });
});
