import { test } from "node:test";
import assert from "node:assert/strict";
import { ScheduleChecker } from "../src/index";
import { formatUtcInstant } from "../src/timezone";
import type { ScheduleInput } from "../src/types";
import { bruteCheck, enumerateSessions, rng } from "./refcheck";
import { parseDate } from "../src/date";

/** 生成一条随机排期（短有效期，覆盖 DST 过渡与各种间隔）。 */
function randomSchedule(rand: () => number, id: string): ScheduleInput {
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  // 有效期：2008-2100 内随机 0.5-3 年的窗口
  const startYear = 2008 + Math.floor(rand() * 90);
  const startDayOfYear = Math.floor(rand() * 360);
  const from = new Date(Date.UTC(startYear, 0, 1 + startDayOfYear));
  const spanDays = 180 + Math.floor(rand() * 900);
  const to = new Date(from.getTime() + spanDays * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  // 锚点：有效期内或之前的一个周一
  const anchorOffset = Math.floor(rand() * 28);
  const anchor = new Date(from.getTime() - anchorOffset * 86400000);
  anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7));
  const minAnchor = new Date(Date.UTC(2008, 0, 7));
  if (anchor < minAnchor) anchor.setTime(minAnchor.getTime());
  // 星期几子集
  const weekdays: number[] = [];
  for (let d = 1; d <= 7; d++) {
    if (rand() < 0.4) weekdays.push(d);
  }
  if (weekdays.length === 0) weekdays.push(1 + Math.floor(rand() * 7));
  const openMinute = Math.floor(rand() * 1380);
  const closeNextDay = rand() < 0.25;
  const duration = 15 + Math.floor(rand() * 480);
  const closeMinute = closeNextDay
    ? Math.floor(rand() * 720)
    : Math.min(1439, openMinute + duration);
  const excludedDates: string[] = [];
  const exclCount = Math.floor(rand() * 10);
  for (let i = 0; i < exclCount; i++) {
    const d = new Date(from.getTime() + Math.floor(rand() * spanDays) * 86400000);
    excludedDates.push(fmt(d));
  }
  const skuCount = 1 + Math.floor(rand() * 3);
  const skuIds: string[] = [];
  for (let i = 0; i < skuCount; i++) {
    skuIds.push(`SKU${Math.floor(rand() * 6)}`);
  }
  return {
    id,
    pickupPointId: pick(["P1", "P2", "P3"]),
    skuIds: [...new Set(skuIds)],
    validFrom: fmt(from),
    validTo: fmt(to),
    anchorMonday: fmt(anchor),
    intervalWeeks: rand() < 0.25 ? 7 + Math.floor(rand() * 46) : 1 + Math.floor(rand() * 6),
    weekdays,
    openMinute,
    closeMinute: closeNextDay ? closeMinute : Math.max(closeMinute, openMinute + 1),
    closeNextDay,
    excludedDates: [...new Set(excludedDates)],
  };
}

test("短有效期随机数据与逐场核对一致", () => {
  const rand = rng(20241007);
  for (let round = 0; round < 2000; round++) {
    const published: ScheduleInput[] = [];
    const pubCount = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < pubCount; i++) {
      published.push(randomSchedule(rand, `pub${i}`));
    }
    const candidate = randomSchedule(rand, "cand");
    const checker = new ScheduleChecker();
    checker.loadPublished(published);
    const got = checker.check(candidate);
    const want = bruteCheck(candidate, published);
    if (want === null) {
      assert.deepEqual(got, { ok: true }, `round ${round} 应无冲突`);
    } else {
      assert.equal(got.ok, false, `round ${round} 应有冲突`);
      if (!got.ok) {
        assert.equal(
          got.earliestInstantUtc,
          formatUtcInstant(want.instantUtc),
          `round ${round} 最早冲突瞬间`,
        );
        // 返回的开放日期必须对应一对真实达到该瞬间的场次
        const hit = published.find((p) => p.id === got.existingScheduleId)!;
        assert.equal(hit !== undefined, true, `round ${round} 命中的既有排期必须存在`);
        const candDay = parseDate(got.candidateOpenDate);
        const existDay = parseDate(got.existingOpenDate);
        const candSessions = enumerateSessions(candidate).filter(
          (s) => s.openDay === candDay,
        );
        const existSessions = enumerateSessions(hit).filter(
          (s) => s.openDay === existDay,
        );
        const achieves = candSessions.some((cs) =>
          existSessions.some(
            (ps) =>
              Math.max(cs.openUtc, ps.openUtc) === want.instantUtc &&
              Math.max(cs.openUtc, ps.openUtc) < Math.min(cs.closeUtc, ps.closeUtc),
          ),
        );
        assert.equal(achieves, true, `round ${round} 返回的开放日期须对应冲突场次`);
        assert.equal(
          hit.skuIds.includes(got.sharedSku) &&
            candidate.skuIds.includes(got.sharedSku),
          true,
          `round ${round} 共享 SKU 必须双方共有`,
        );
      }
    }
  }
});
