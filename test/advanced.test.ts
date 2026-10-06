import { test } from "node:test";
import assert from "node:assert/strict";
import { ScheduleChecker } from "../src/index";
import type { ScheduleInput } from "../src/types";

function base(overrides: Partial<ScheduleInput>): ScheduleInput {
  return {
    id: "s1",
    pickupPointId: "P1",
    skuIds: ["SKU1"],
    validFrom: "2024-01-01",
    validTo: "2024-12-31",
    anchorMonday: "2024-01-01",
    intervalWeeks: 1,
    weekdays: [1],
    openMinute: 600,
    closeMinute: 720,
    closeNextDay: false,
    excludedDates: [],
    ...overrides,
  };
}

test("CRT：间隔 4 周与 6 周锚点错开 1 周永不冲突", () => {
  const c = new ScheduleChecker();
  c.loadPublished([
    base({ id: "a", intervalWeeks: 4, anchorMonday: "2024-01-01" }),
  ]);
  const cand = base({ id: "cand", intervalWeeks: 6, anchorMonday: "2024-01-08" });
  assert.deepEqual(c.check(cand), { ok: true });
});

test("CRT：间隔 4 周与 6 周锚点错开 2 周每 12 周冲突", () => {
  const c = new ScheduleChecker();
  c.loadPublished([
    base({ id: "a", intervalWeeks: 4, anchorMonday: "2024-01-01" }),
  ]);
  // A 场次周：01-01, 01-29, 02-26(第8周)...；B 锚 01-15 每 6 周：01-15, 02-26...
  const cand = base({ id: "cand", intervalWeeks: 6, anchorMonday: "2024-01-15" });
  const r = c.check(cand);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.candidateOpenDate, "2024-02-26");
    assert.equal(r.existingOpenDate, "2024-02-26");
    assert.equal(r.earliestInstantUtc, "2024-02-26T16:00:00Z"); // 10:00 CST
  }
});

test("远未来冲突：多年后才相交也能检出", () => {
  const c = new ScheduleChecker();
  // 既有：5000 年起每 52 周，周一 11:00-13:00
  c.loadPublished([
    base({
      id: "a",
      validFrom: "4999-12-01",
      validTo: "9999-12-31",
      anchorMonday: "5000-01-06",
      intervalWeeks: 52,
      openMinute: 660,
      closeMinute: 780,
    }),
  ]);
  // 候选：2008-9999 全程每周一 10:00-12:00
  const cand = base({
    id: "cand",
    validFrom: "2008-01-01",
    validTo: "9999-12-31",
    anchorMonday: "2008-01-07",
  });
  const r = c.check(cand);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.candidateOpenDate, "5000-01-06");
    assert.equal(r.existingOpenDate, "5000-01-06");
    assert.equal(r.earliestInstantUtc, "5000-01-06T17:00:00Z"); // 11:00 CST
  }
});

test("周六开放、截止落入次日春季缺失时刻整场取消", () => {
  const c = new ScheduleChecker();
  // 既有：周六 23:00 开放，次日（周日）02:30 截止；2024-03-09 的截止不存在
  c.loadPublished([
    base({
      id: "a",
      weekdays: [6],
      validFrom: "2024-03-04",
      validTo: "2024-03-16",
      anchorMonday: "2024-03-04",
      openMinute: 1380,
      closeMinute: 150,
      closeNextDay: true,
    }),
  ]);
  // 候选：周日 03:30-05:00，仅同一周
  const cand = base({
    id: "cand",
    weekdays: [7],
    validFrom: "2024-03-04",
    validTo: "2024-03-16",
    anchorMonday: "2024-03-04",
    openMinute: 210,
    closeMinute: 300,
  });
  assert.deepEqual(c.check(cand), { ok: true });
});

test("周六开放跨到普通周日凌晨正常相交", () => {
  const c = new ScheduleChecker();
  // 既有：周六 23:00 开放，次日 02:30 截止（2024-03-16 → 03-17，正常）
  c.loadPublished([
    base({
      id: "a",
      weekdays: [6],
      validFrom: "2024-03-11",
      validTo: "2024-03-23",
      anchorMonday: "2024-03-11",
      openMinute: 1380,
      closeMinute: 150,
      closeNextDay: true,
    }),
  ]);
  // 候选：周日 02:00-04:00
  const r = c.check(
    base({
      id: "cand",
      weekdays: [7],
      validFrom: "2024-03-11",
      validTo: "2024-03-23",
      anchorMonday: "2024-03-11",
      openMinute: 120,
      closeMinute: 240,
    }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.candidateOpenDate, "2024-03-17");
    assert.equal(r.existingOpenDate, "2024-03-16");
    // 相交开始 = 周日 02:00 CDT = 07:00Z
    assert.equal(r.earliestInstantUtc, "2024-03-17T07:00:00Z");
  }
});

test("52 周间隔与 1 周间隔在完整有效期内的对齐", () => {
  const c = new ScheduleChecker();
  // 既有：每 52 周，锚 2008-01-07，周一 10:00-12:00，全程有效
  c.loadPublished([
    base({
      id: "a",
      validFrom: "2008-01-01",
      validTo: "9999-12-31",
      anchorMonday: "2008-01-07",
      intervalWeeks: 52,
    }),
  ]);
  // 候选：每周一 10:00-12:00，但有效期避开既有场次周：
  // 既有场次 2008-01-07, 2009-01-05（+52 周，跨闰年）...
  // 候选只在 2008-01-14 至 2008-12-22 有效 → 不冲突
  const miss = base({
    id: "cand",
    validFrom: "2008-01-14",
    validTo: "2008-12-22",
    anchorMonday: "2008-01-14",
  });
  assert.deepEqual(c.check(miss), { ok: true });
  // 候选覆盖 2009-01-05 → 冲突
  const hit = base({
    id: "cand",
    validFrom: "2008-12-22",
    validTo: "2009-01-31",
    anchorMonday: "2008-12-22",
  });
  const r = c.check(hit);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.candidateOpenDate, "2009-01-05");
  }
});
