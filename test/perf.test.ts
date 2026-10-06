import { test } from "node:test";
import assert from "node:assert/strict";
import { ScheduleChecker } from "../src/index";
import type { ScheduleInput } from "../src/types";
import { rng } from "./refcheck";

const TOTAL = 30000;
const HOT = 1000;
const CANDIDATES = 100;
const MIB = 1024 * 1024;

function buildPublished(): ScheduleInput[] {
  const rand = rng(987654321);
  const out: ScheduleInput[] = [];
  // 1000 条与候选共享取货点和 SKU 的热点排期：全部 2008-9999 完整有效期
  for (let i = 0; i < HOT; i++) {
    const open = 360 + (i % 8) * 60; // 06:00 - 13:00
    const excludedDates: string[] = [];
    // 部分热点排期带满 64 个排除日期，压力测试排除跳过逻辑
    if (i % 10 === 0) {
      for (let k = 0; k < 64; k++) {
        const y = 2008 + ((i * 7 + k * 113) % 7992);
        const m = 1 + ((i + k) % 12);
        const d = 1 + ((i * 3 + k * 7) % 28);
        excludedDates.push(
          `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        );
      }
    }
    out.push({
      id: `hot-${i}`,
      pickupPointId: "P-HOT",
      skuIds: ["SKU-HOT", `SKU-${i % 50}`],
      validFrom: "2008-01-01",
      validTo: "9999-12-31",
      anchorMonday: "2008-01-07",
      intervalWeeks: 1,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      openMinute: open,
      closeMinute: open + 120,
      closeNextDay: false,
      excludedDates,
    });
  }
  // 其余 29000 条：分散取货点，全部完整有效期
  for (let i = HOT; i < TOTAL; i++) {
    const weekdayCount = 1 + Math.floor(rand() * 7);
    const weekdays: number[] = [];
    for (let d = 1; d <= 7 && weekdays.length < weekdayCount; d++) {
      if (rand() < 0.5) weekdays.push(d);
    }
    if (weekdays.length === 0) weekdays.push(3);
    const open = Math.floor(rand() * 1200);
    out.push({
      id: `gen-${i}`,
      pickupPointId: `P-${i % 2900}`,
      skuIds: [`SKU-${Math.floor(rand() * 500)}`],
      validFrom: "2008-01-01",
      validTo: "9999-12-31",
      anchorMonday: "2008-01-07",
      intervalWeeks: 1 + Math.floor(rand() * 52),
      weekdays,
      openMinute: open,
      closeMinute: Math.min(1439, open + 60),
      closeNextDay: false,
      excludedDates: [],
    });
  }
  return out;
}

function buildCandidates(): ScheduleInput[] {
  const out: ScheduleInput[] = [];
  for (let i = 0; i < CANDIDATES; i++) {
    const conflicting = i % 2 === 0;
    out.push({
      id: `cand-${i}`,
      pickupPointId: "P-HOT",
      skuIds: ["SKU-HOT"],
      validFrom: "2008-01-01",
      validTo: "9999-12-31",
      anchorMonday: "2008-01-07",
      intervalWeeks: 1,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      // 一半与热点排期相交（07:00-08:00），一半完全无冲突（20:00-22:00）
      openMinute: conflicting ? 420 : 1200,
      closeMinute: conflicting ? 480 : 1320,
      closeNextDay: false,
      excludedDates: [],
    });
  }
  return out;
}

test("规模/内存/耗时：30k 完整有效期排期", () => {
  const published = buildPublished();
  assert.equal(published.length, TOTAL);
  const checker = new ScheduleChecker();

  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  checker.loadPublished(published);
  const loadMs = Date.now() - t0;
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(checker.size, TOTAL);
  assert.ok(loadMs <= 5000, `装入耗时 ${loadMs}ms 超过 5s`);
  assert.ok(
    heapAfter - heapBefore <= 256 * MIB,
    `装入内存增量 ${((heapAfter - heapBefore) / MIB).toFixed(1)}MiB 超过 256MiB`,
  );
  assert.ok(
    heapAfter <= 256 * MIB,
    `堆内存 ${(heapAfter / MIB).toFixed(1)}MiB 超过 256MiB`,
  );

  const candidates = buildCandidates();
  const t1 = Date.now();
  let conflictCount = 0;
  for (const cand of candidates) {
    const r = checker.check(cand);
    if (!r.ok) conflictCount++;
  }
  const checkMs = Date.now() - t1;
  assert.ok(checkMs <= 20000, `100 条检查总耗时 ${checkMs}ms 超过 20s`);
  assert.equal(conflictCount, CANDIDATES / 2);
  console.log(
    `  perf: load=${loadMs}ms heapDelta=${((heapAfter - heapBefore) / MIB).toFixed(1)}MiB ` +
      `heapTotal=${(heapAfter / MIB).toFixed(1)}MiB checks=${checkMs}ms conflicts=${conflictCount}`,
  );
});
