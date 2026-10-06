/** 短有效期随机排期：库判定与独立逐场核对结果必须一致。 */
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/index.js";
import type { ScheduleInput } from "../src/types.js";
import { serialDayToDateString, daysFromCivil, weekdayOf } from "../src/calendar.js";
import { bruteForceConflict, enumerateSessions } from "./bruteForce.js";

/** 可复现的伪随机数生成器。 */
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

interface GenOptions {
  seed: number;
  id: string;
  pointPool: string[];
  skuPool: string[];
}

function randomSchedule(opts: GenOptions): ScheduleInput {
  const rand = mulberry32(opts.seed);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  // 有效期：2026 年内 1~6 个月（覆盖春秋两次 DST 转换）
  const yearStart = daysFromCivil(2026, 1, 1);
  const start = yearStart + Math.floor(rand() * 300);
  const lengthDays = 30 + Math.floor(rand() * 150);
  const validFrom = start;
  const validTo = Math.min(start + lengthDays, daysFromCivil(2026, 12, 31));
  // 锚点周一：有效期前 0~4 周内的某个周一
  const anchorBase = validFrom - Math.floor(rand() * 28);
  const anchor = anchorBase - weekdayOf(anchorBase);
  // 星期几：1~3 个
  const weekdayCount = 1 + Math.floor(rand() * 3);
  const weekdaySet = new Set<number>();
  while (weekdaySet.size < weekdayCount) weekdaySet.add(Math.floor(rand() * 7));
  // 间隔 1~4 周
  const intervalWeeks = 1 + Math.floor(rand() * 4);
  // 开放时间：一半概率落在 00:00~04:00（DST 敏感区）
  const openMin = rand() < 0.5 ? Math.floor(rand() * 240) : Math.floor(rand() * 1440);
  // 时长：30 分钟 ~ 次日截止为上限
  const maxDuration = 2879 - openMin;
  const duration = 30 + Math.floor(rand() * (maxDuration - 30));
  const closeTotal = openMin + duration;
  const closeNextDay = closeTotal >= 1440;
  const closeMin = closeNextDay ? closeTotal - 1440 : closeTotal;
  // 排除日期：0~4 个
  const excludedCount = Math.floor(rand() * 5);
  const excludedDates: string[] = [];
  for (let i = 0; i < excludedCount; i++) {
    excludedDates.push(
      serialDayToDateString(validFrom + Math.floor(rand() * (validTo - validFrom + 1))),
    );
  }
  // SKU：1~3 个
  const skuCount = 1 + Math.floor(rand() * 3);
  const skus = new Set<string>();
  while (skus.size < skuCount) skus.add(pick(opts.skuPool));
  return {
    id: opts.id,
    pickupPointId: pick(opts.pointPool),
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

describe("与逐场核对一致的随机对照", () => {
  const skuPool = ["sku-a", "sku-b", "sku-c", "sku-d"];
  const pointPool = ["point-1", "point-2"];

  for (const [rounds, seedBase] of [
    [400, 1000],
    [400, 5000],
  ] as const) {
    it(`随机 ${rounds} 组（种子 ${seedBase}）判定与最早瞬间一致`, () => {
      for (let round = 0; round < rounds; round++) {
        const seed = seedBase + round;
        const existing: ScheduleInput[] = [];
        const existingCount = 1 + (seed % 3);
        for (let i = 0; i < existingCount; i++) {
          existing.push(
            randomSchedule({
              seed: seed * 17 + i * 131,
              id: `ex-${round}-${i}`,
              pointPool,
              skuPool,
            }),
          );
        }
        const pending = randomSchedule({
          seed: seed * 31 + 7,
          id: `pd-${round}`,
          pointPool,
          skuPool,
        });

        const store = new ScheduleStore(existing);
        const result = store.check(pending);

        // 独立核对：对待发布与每条同取货点且共享 SKU 的既有排期逐场比较
        let bruteBest: number | null = null;
        for (const ex of existing) {
          if (ex.pickupPointId !== pending.pickupPointId) continue;
          if (!ex.skus.some((s) => pending.skus.includes(s))) continue;
          const conflict = bruteForceConflict(pending, ex);
          if (conflict && (bruteBest === null || conflict.instant < bruteBest)) {
            bruteBest = conflict.instant;
          }
        }

        if (bruteBest === null) {
          expect(result.canPublish, `round ${round}: 期望可发布`).toBe(true);
          continue;
        }

        expect(result.canPublish, `round ${round}: 期望不可发布`).toBe(false);
        const info = result.conflict!;
        expect(
          info.earliestOverlapStartMinutesUtc,
          `round ${round}: 最早相交瞬间`,
        ).toBe(bruteBest);

        // 报告的双方开放日必须对应真实存在、且相交于该瞬间的场次
        const reportedExisting = existing.find((e) => e.id === info.existingScheduleId)!;
        expect(reportedExisting, `round ${round}: 既有排期 id 应存在`).toBeDefined();
        expect(
          pending.skus.includes(info.sharedSku) &&
            reportedExisting.skus.includes(info.sharedSku),
          `round ${round}: 共享 SKU`,
        ).toBe(true);
        const pendingSession = enumerateSessions(pending).find(
          (s) => serialDayToDateString(s.openDay) === info.pendingOpenDate,
        );
        const existingSession = enumerateSessions(reportedExisting).find(
          (s) => serialDayToDateString(s.openDay) === info.existingOpenDate,
        );
        expect(pendingSession, `round ${round}: 待发布方开放日应有场次`).toBeDefined();
        expect(existingSession, `round ${round}: 既有方开放日应有场次`).toBeDefined();
        expect(
          Math.max(pendingSession!.openUtc, existingSession!.openUtc),
          `round ${round}: 报告场次的相交起点`,
        ).toBe(bruteBest);
        expect(
          pendingSession!.openUtc < existingSession!.closeUtc &&
            existingSession!.openUtc < pendingSession!.closeUtc,
          `round ${round}: 报告场次应真实相交`,
        ).toBe(true);
      }
    });
  }
});
