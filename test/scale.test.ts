/**
 * 规模验证：30,000 条已发布排期（全部 2008..9999 完整有效期）。
 * - 装入耗时 < 5s
 * - 运行峰值内存增量 < 256 MiB
 * - 100 条待发布排期（每条与 1000 条既有排期共享取货点和 SKU）检查总耗时 < 20s
 *   其中包含长有效期完全无冲突的检查。
 */
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/index.js";
import type { ScheduleInput } from "../src/types.js";
import { serialDayToDateString, daysFromCivil, weekdayOf } from "../src/calendar.js";

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

const FULL_FROM = "2008-01-01";
const FULL_TO = "9999-12-31";
const MIXED_POINTS = 20;
const SAFE_POINTS = 10;
const PER_POINT = 1000;
const TOTAL = (MIXED_POINTS + SAFE_POINTS) * PER_POINT;

function pad(v: number): string {
  return String(v).padStart(2, "0");
}

function timeStr(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** 生成 30,000 条全有效期排期。 */
function generatePublished(): ScheduleInput[] {
  const rand = mulberry32(20261006);
  const fullFrom = daysFromCivil(2008, 1, 1);
  const result: ScheduleInput[] = [];
  for (let p = 0; p < MIXED_POINTS + SAFE_POINTS; p++) {
    const pointId = `point-${p}`;
    const safe = p >= MIXED_POINTS;
    for (let i = 0; i < PER_POINT; i++) {
      // 锚点：2008 年初某个周一
      const anchorBase = fullFrom + 7 + Math.floor(rand() * 21);
      const anchor = anchorBase - weekdayOf(anchorBase);
      const weekdayCount = 1 + Math.floor(rand() * 4);
      const weekdaySet = new Set<number>();
      while (weekdaySet.size < weekdayCount) weekdaySet.add(Math.floor(rand() * 7));
      const intervalWeeks = 1 + Math.floor(rand() * 52);
      // 安全点：窗口集中在 08:00-12:00；混合点：全天随机
      const openMin = safe
        ? 8 * 60 + Math.floor(rand() * 180)
        : Math.floor(rand() * 1380);
      const duration = 30 + Math.floor(rand() * (safe ? 120 : 240));
      const closeTotal = openMin + duration;
      const closeNextDay = closeTotal >= 1440;
      const closeMin = closeNextDay ? closeTotal - 1440 : closeTotal;
      const excludedDates: string[] = [];
      const excludedCount = Math.floor(rand() * 3);
      for (let e = 0; e < excludedCount; e++) {
        excludedDates.push(
          serialDayToDateString(fullFrom + Math.floor(rand() * 2_900_000)),
        );
      }
      const skus = [`sku-point-${p}`, `sku-extra-${Math.floor(rand() * 50)}`];
      result.push({
        id: `pub-${p}-${i}`,
        pickupPointId: pointId,
        skus,
        validFrom: FULL_FROM,
        validTo: FULL_TO,
        anchorMonday: serialDayToDateString(anchor),
        intervalWeeks,
        weekdays: [...weekdaySet].sort((x, y) => x - y),
        openTime: timeStr(openMin),
        closeTime: timeStr(closeMin),
        closeNextDay,
        excludedDates,
      });
    }
  }
  return result;
}

/** 生成 100 条待发布排期：60 条落在混合点（大概率有冲突），40 条落在安全点（无冲突）。 */
function generatePendings(): ScheduleInput[] {
  const rand = mulberry32(777);
  const fullFrom = daysFromCivil(2008, 1, 1);
  const result: ScheduleInput[] = [];
  for (let i = 0; i < 100; i++) {
    const safe = i >= 60;
    const p = safe ? MIXED_POINTS + (i % SAFE_POINTS) : i % MIXED_POINTS;
    const anchorBase = fullFrom + 10 + Math.floor(rand() * 14);
    const anchor = anchorBase - weekdayOf(anchorBase);
    const weekdayCount = 1 + Math.floor(rand() * 3);
    const weekdaySet = new Set<number>();
    while (weekdaySet.size < weekdayCount) weekdaySet.add(Math.floor(rand() * 7));
    const intervalWeeks = 1 + Math.floor(rand() * 52);
    // 安全点待发布：22:00-23:00，与既有 08:00-12:00 窗口永不相交
    const openMin = safe ? 22 * 60 : Math.floor(rand() * 1380);
    const duration = safe ? 60 : 30 + Math.floor(rand() * 240);
    const closeTotal = openMin + duration;
    const closeNextDay = closeTotal >= 1440;
    const closeMin = closeNextDay ? closeTotal - 1440 : closeTotal;
    result.push({
      id: `pending-${i}`,
      pickupPointId: `point-${p}`,
      skus: [`sku-point-${p}`],
      validFrom: FULL_FROM,
      validTo: FULL_TO,
      anchorMonday: serialDayToDateString(anchor),
      intervalWeeks,
      weekdays: [...weekdaySet].sort((x, y) => x - y),
      openTime: timeStr(openMin),
      closeTime: timeStr(closeMin),
      closeNextDay,
    });
  }
  return result;
}

describe("规模与性能", () => {
  it(
    "30,000 条装入 < 5s；100 条检查 < 20s；内存增量 < 256MiB",
    { timeout: 180000 },
    () => {
      const rssBefore = process.memoryUsage().rss;

      const published = generatePublished();
      expect(published.length).toBe(TOTAL);

      const store = new ScheduleStore();
      const loadStart = performance.now();
      store.load(published);
      const loadMs = performance.now() - loadStart;
      expect(store.count).toBe(TOTAL);
      expect(loadMs, `装入耗时 ${loadMs.toFixed(0)}ms`).toBeLessThan(5000);

      const pendings = generatePendings();
      const checkStart = performance.now();
      let conflictCount = 0;
      for (const pending of pendings) {
        const result = store.check(pending);
        if (!result.canPublish) conflictCount++;
      }
      const checkMs = performance.now() - checkStart;
      expect(checkMs, `100 条检查总耗时 ${checkMs.toFixed(0)}ms`).toBeLessThan(20000);

      // 安全点上的 40 条必须全部无冲突（长有效期完全无冲突场景）
      for (let i = 60; i < 100; i++) {
        expect(store.check(pendings[i]!).canPublish, `pending-${i} 应无冲突`).toBe(true);
      }

      const rssAfter = process.memoryUsage().rss;
      const deltaMiB = (rssAfter - rssBefore) / (1024 * 1024);
      expect(deltaMiB, `内存增量 ${deltaMiB.toFixed(1)} MiB`).toBeLessThan(256);

      console.log(
        `load=${loadMs.toFixed(0)}ms checks=${checkMs.toFixed(0)}ms ` +
          `conflicts=${conflictCount}/100 memDelta=${deltaMiB.toFixed(1)}MiB`,
      );
    },
  );

  it(
    "对抗性无冲突：全部 7 个星期几、窗口首尾相接，100 条检查 < 20s",
    { timeout: 120000 },
    () => {
      // 既有排期 08:00-10:00、待发布 10:00-12:00，同一批星期几，永不重叠；
      // 每条待发布需扫描 1000 条候选 × 49 个星期几对且无任何冲突可提前结束。
      const rand = mulberry32(42);
      const fullFrom = daysFromCivil(2008, 1, 1);
      const published: ScheduleInput[] = [];
      for (let i = 0; i < TOTAL; i++) {
        const anchorBase = fullFrom + 7 + Math.floor(rand() * 21);
        const anchor = anchorBase - weekdayOf(anchorBase);
        published.push({
          id: `pub-${i}`,
          pickupPointId: `point-${i % 30}`,
          skus: [`sku-point-${i % 30}`],
          validFrom: FULL_FROM,
          validTo: FULL_TO,
          anchorMonday: serialDayToDateString(anchor),
          intervalWeeks: 1 + Math.floor(rand() * 52),
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          openTime: "08:00",
          closeTime: "10:00",
          closeNextDay: false,
        });
      }
      const store = new ScheduleStore(published);
      const pendings: ScheduleInput[] = [];
      for (let i = 0; i < 100; i++) {
        const anchorBase = fullFrom + 10 + Math.floor(rand() * 14);
        const anchor = anchorBase - weekdayOf(anchorBase);
        pendings.push({
          id: `pd-${i}`,
          pickupPointId: `point-${i % 30}`,
          skus: [`sku-point-${i % 30}`],
          validFrom: FULL_FROM,
          validTo: FULL_TO,
          anchorMonday: serialDayToDateString(anchor),
          intervalWeeks: 1 + Math.floor(rand() * 52),
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          openTime: "10:00",
          closeTime: "12:00",
          closeNextDay: false,
        });
      }
      const t0 = performance.now();
      let ok = 0;
      for (const pd of pendings) {
        if (store.check(pd).canPublish) ok++;
      }
      const ms = performance.now() - t0;
      expect(ok).toBe(100);
      expect(ms, `对抗性无冲突 100 条检查耗时 ${ms.toFixed(0)}ms`).toBeLessThan(20000);
      console.log(`adversarial no-conflict checks=${ms.toFixed(0)}ms`);
    },
  );
});
