/** 多年有效期 + 大间隔（N 至 52）+ 较多排除日的随机对照。 */
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/index.js";
import type { ScheduleInput } from "../src/types.js";
import { serialDayToDateString, daysFromCivil, weekdayOf } from "../src/calendar.js";
import { bruteForceConflict } from "./bruteForce.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(v: number): string {
  return String(v).padStart(2, "0");
}

function randomSchedule(seed: number, id: string): ScheduleInput {
  const rand = mulberry32(seed);
  // 有效期：2025~2029 年间 1~3 年
  const start = daysFromCivil(2025, 1, 1) + Math.floor(rand() * 900);
  const lengthDays = 365 + Math.floor(rand() * 730);
  const validFrom = start;
  const validTo = Math.min(start + lengthDays, daysFromCivil(2029, 12, 31));
  const anchorBase = validFrom - Math.floor(rand() * 56);
  const anchor = anchorBase - weekdayOf(anchorBase);
  const weekdayCount = 1 + Math.floor(rand() * 3);
  const weekdaySet = new Set<number>();
  while (weekdaySet.size < weekdayCount) weekdaySet.add(Math.floor(rand() * 7));
  const intervalWeeks = 1 + Math.floor(rand() * 52);
  const openMin = rand() < 0.5 ? Math.floor(rand() * 240) : Math.floor(rand() * 1440);
  const maxDuration = 2879 - openMin;
  const duration = 30 + Math.floor(rand() * (maxDuration - 30));
  const closeTotal = openMin + duration;
  const closeNextDay = closeTotal >= 1440;
  const closeMin = closeNextDay ? closeTotal - 1440 : closeTotal;
  const excludedCount = Math.floor(rand() * 9);
  const excludedDates: string[] = [];
  for (let i = 0; i < excludedCount; i++) {
    excludedDates.push(
      serialDayToDateString(validFrom + Math.floor(rand() * (validTo - validFrom + 1))),
    );
  }
  const skuPool = ["sku-a", "sku-b", "sku-c"];
  const skuCount = 1 + Math.floor(rand() * 3);
  const skus = new Set<string>();
  while (skus.size < skuCount) skus.add(skuPool[Math.floor(rand() * skuPool.length)]!);
  return {
    id,
    pickupPointId: "point-x",
    skus: [...skus],
    validFrom: serialDayToDateString(validFrom),
    validTo: serialDayToDateString(validTo),
    anchorMonday: serialDayToDateString(anchor),
    intervalWeeks,
    weekdays: [...weekdaySet].sort((x, y) => x - y),
    openTime: `${pad(Math.floor(openMin / 60))}:${pad(openMin % 60)}`,
    closeTime: `${pad(Math.floor(closeMin / 60))}:${pad(closeMin % 60)}`,
    closeNextDay,
    excludedDates,
  };
}

describe("多年有效期随机对照", () => {
  it("150 组判定与最早瞬间一致", { timeout: 60000 }, () => {
    for (let round = 0; round < 150; round++) {
      const a = randomSchedule(91000 + round * 7, `a-${round}`);
      const b = randomSchedule(95000 + round * 13, `b-${round}`);
      // 强制共享 SKU 与同取货点
      b.skus = [...new Set([...b.skus, a.skus[0]!])];
      b.pickupPointId = a.pickupPointId;

      const store = new ScheduleStore([b]);
      const result = store.check(a);
      const brute = bruteForceConflict(a, b);

      if (brute === null) {
        expect(result.canPublish, `round ${round}: 期望可发布`).toBe(true);
      } else {
        expect(result.canPublish, `round ${round}: 期望不可发布`).toBe(false);
        expect(
          result.conflict?.earliestOverlapStartMinutesUtc,
          `round ${round}: 最早相交瞬间`,
        ).toBe(brute.instant);
      }
    }
  });
});
