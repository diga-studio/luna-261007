import { test } from "node:test";
import assert from "node:assert/strict";
import { ScheduleChecker } from "../src/index";
import type { ScheduleInput } from "../src/types";

// 2024-03-10 为 3 月第二个周日（02:00→03:00）；2024-11-03 为 11 月第一个周日。
function springWeek(overrides: Partial<ScheduleInput>): ScheduleInput {
  return {
    id: "s",
    pickupPointId: "P1",
    skuIds: ["SKU1"],
    validFrom: "2024-03-04",
    validTo: "2024-03-16",
    anchorMonday: "2024-03-04",
    intervalWeeks: 1,
    weekdays: [7], // 周日
    openMinute: 150, // 02:30
    closeMinute: 240, // 04:00
    closeNextDay: false,
    excludedDates: [],
    ...overrides,
  };
}

function fallWeek(overrides: Partial<ScheduleInput>): ScheduleInput {
  return {
    id: "s",
    pickupPointId: "P1",
    skuIds: ["SKU1"],
    validFrom: "2024-10-28",
    validTo: "2024-11-09",
    anchorMonday: "2024-10-28",
    intervalWeeks: 1,
    weekdays: [7],
    openMinute: 60, // 01:00
    closeMinute: 90, // 01:30
    closeNextDay: false,
    excludedDates: [],
    ...overrides,
  };
}

test("春季开放落入缺失时刻整场取消", () => {
  const c = new ScheduleChecker();
  // 既有：周日 03:30-05:00；候选开放 02:30（不存在）→ 唯一可能冲突的场次被取消
  c.loadPublished([
    springWeek({ id: "a", openMinute: 210, closeMinute: 300 }),
  ]);
  assert.deepEqual(c.check(springWeek({ id: "cand" })), { ok: true });
});

test("春季截止落入缺失时刻整场取消", () => {
  const c = new ScheduleChecker();
  // 候选 01:00-02:30：截止 02:30 不存在 → 取消
  c.loadPublished([
    springWeek({ id: "a", openMinute: 210, closeMinute: 300 }),
  ]);
  assert.deepEqual(
    c.check(springWeek({ id: "cand", openMinute: 60, closeMinute: 150 })),
    { ok: true },
  );
});

test("春季缺失时刻之外正常判定", () => {
  const c = new ScheduleChecker();
  // 候选 03:00-04:00（03:00 存在）与既有 03:30-05:00 相交
  c.loadPublished([
    springWeek({ id: "a", openMinute: 210, closeMinute: 300 }),
  ]);
  const r = c.check(springWeek({ id: "cand", openMinute: 180, closeMinute: 240 }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    // 相交开始 = 03:30 CDT = 08:30Z
    assert.equal(r.earliestInstantUtc, "2024-03-10T08:30:00Z");
    assert.equal(r.candidateOpenDate, "2024-03-10");
  }
});

test("秋季重复小时内钟面不相交的窗口真实相交", () => {
  const c = new ScheduleChecker();
  // 既有：周日 01:45-02:30；候选：周日 01:00-01:30。钟面不相交。
  c.loadPublished([
    fallWeek({ id: "a", openMinute: 105, closeMinute: 150 }),
  ]);
  const r = c.check(fallWeek({ id: "cand" }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    // 候选真实窗口 [01:00 CDT, 01:30 CST] = [06:00Z, 07:30Z]
    // 既有真实窗口 [01:45 CDT(较早), 02:30 CST(较晚)] = [06:45Z, 08:30Z]
    // 相交开始 = 06:45Z
    assert.equal(r.earliestInstantUtc, "2024-11-03T06:45:00Z");
    assert.equal(r.candidateOpenDate, "2024-11-03");
    assert.equal(r.existingOpenDate, "2024-11-03");
  }
});

test("非回拨周同样的钟面不冲突", () => {
  const c = new ScheduleChecker();
  // 既有有效期仅覆盖 10 月最后一个周（非回拨周）
  c.loadPublished([
    fallWeek({
      id: "a",
      openMinute: 120,
      closeMinute: 150,
      validFrom: "2024-10-28",
      validTo: "2024-10-28",
    }),
  ]);
  // 候选也只在该周 → 双方场次都在 2024-10-27？周日是 10-27，不在既有有效期
  // 调整：既有有效到 10-27（周日）
  const c2 = new ScheduleChecker();
  c2.loadPublished([
    fallWeek({
      id: "a",
      openMinute: 120,
      closeMinute: 150,
      validFrom: "2024-10-21",
      validTo: "2024-10-27",
      anchorMonday: "2024-10-21",
    }),
  ]);
  const r = c2.check(
    fallWeek({
      id: "cand",
      validFrom: "2024-10-21",
      validTo: "2024-10-27",
      anchorMonday: "2024-10-21",
    }),
  );
  assert.deepEqual(r, { ok: true });
});

test("秋季开放取较早真实瞬间", () => {
  const c = new ScheduleChecker();
  // 既有：周日 00:30-01:10（截止 01:10 重复 → 较晚 07:10Z）
  // 候选：周日 01:05-01:20（开放重复 → 较早 06:05Z）
  // 候选真实 [06:05Z, 07:20Z]，既有真实 [05:30Z? 00:30 CDT=05:30Z, 07:10Z] → 相交
  c.loadPublished([
    fallWeek({ id: "a", openMinute: 30, closeMinute: 70 }),
  ]);
  const r = c.check(fallWeek({ id: "cand", openMinute: 65, closeMinute: 80 }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.earliestInstantUtc, "2024-11-03T06:05:00Z");
  }
});
