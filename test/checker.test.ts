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
    anchorMonday: "2024-01-01", // 周一
    intervalWeeks: 1,
    weekdays: [1], // 周一
    openMinute: 600, // 10:00
    closeMinute: 720, // 12:00
    closeNextDay: false,
    excludedDates: [],
    ...overrides,
  };
}

test("取货点不同不冲突", () => {
  const c = new ScheduleChecker();
  c.loadPublished([base({ id: "a", pickupPointId: "P2" })]);
  assert.deepEqual(c.check(base({ id: "cand" })), { ok: true });
});

test("无共享 SKU 不冲突", () => {
  const c = new ScheduleChecker();
  c.loadPublished([base({ id: "a", skuIds: ["SKU2"] })]);
  assert.deepEqual(c.check(base({ id: "cand" })), { ok: true });
});

test("窗口相交冲突并给出详情", () => {
  const c = new ScheduleChecker();
  c.loadPublished([base({ id: "a", openMinute: 660 })]) // 11:00-12:00
  const r = c.check(base({ id: "cand" }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.existingScheduleId, "a");
    assert.equal(r.sharedSku, "SKU1");
    // 最早冲突：2024-01-01 11:00 CST = 17:00Z
    assert.equal(r.earliestInstantUtc, "2024-01-01T17:00:00Z");
    assert.equal(r.candidateOpenDate, "2024-01-01");
    assert.equal(r.existingOpenDate, "2024-01-01");
  }
});

test("首尾相接不冲突", () => {
  const c = new ScheduleChecker();
  c.loadPublished([base({ id: "a", openMinute: 720, closeMinute: 840 })]); // 12:00-14:00
  assert.deepEqual(c.check(base({ id: "cand" })), { ok: true }); // 10:00-12:00
});

test("排除日期使最早冲突顺延", () => {
  // 既有排除 2024 年 1 月的 4 个周一，候选最早冲突顺延到 2024-01-29
  const c = new ScheduleChecker();
  c.loadPublished([
    base({
      id: "a",
      excludedDates: ["2024-01-01", "2024-01-08", "2024-01-15", "2024-01-22"],
    }),
  ]);
  const r = c.check(base({ id: "cand", openMinute: 630, closeMinute: 660 }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.candidateOpenDate, "2024-01-29");
    assert.equal(r.existingOpenDate, "2024-01-29");
    assert.equal(r.earliestInstantUtc, "2024-01-29T16:30:00Z"); // 10:30 CST
  }
  // 既有排除全部 2024 周一（53 个，未超 64 上限）后不再冲突
  const mondays: string[] = [];
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= 31; d++) {
      const date = new Date(Date.UTC(2024, m, d));
      if (date.getUTCMonth() !== m) break;
      if (date.getUTCDay() === 1) mondays.push(date.toISOString().slice(0, 10));
    }
  }
  assert.equal(mondays.length <= 64, true);
  const c2 = new ScheduleChecker();
  c2.loadPublished([base({ id: "a", excludedDates: mondays })]);
  assert.deepEqual(c2.check(base({ id: "cand" })), { ok: true });
});

test("有效期大部分重合、唯一冲突在最后一个可生成场次", () => {
  // 既有：每周一 10:00-12:00，有效期 2024-01-01 至 2024-06-30
  // 候选：每周一 11:00-13:00，有效期 2024-01-15 至 2024-06-24
  // 两条排期有效期大部分重合 → 冲突很多。改造：既有只在最后一周生成。
  // 用 intervalWeeks 让既有只在 2024-06-24 那周与候选重叠：
  // 既有每 26 周一次，锚点 2024-06-24 → 场次 2024-06-24, +26周...
  const existing = base({
    id: "a",
    anchorMonday: "2024-06-24",
    intervalWeeks: 26,
    validFrom: "2024-01-01",
    validTo: "2024-12-31",
  });
  const candidate = base({
    id: "cand",
    openMinute: 660,
    closeMinute: 780,
    validFrom: "2024-01-01",
    validTo: "2024-06-24", // 最后一个可生成场次即 2024-06-24
  });
  const c = new ScheduleChecker();
  c.loadPublished([existing]);
  const r = c.check(candidate);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.candidateOpenDate, "2024-06-24");
    assert.equal(r.existingOpenDate, "2024-06-24");
    assert.equal(r.earliestInstantUtc, "2024-06-24T16:00:00Z"); // 11:00 CDT
  }
  // 排除该场后不再冲突
  const c2 = new ScheduleChecker();
  c2.loadPublished([{ ...existing, excludedDates: ["2024-06-24"] }]);
  // 既有下一场在 2024-12-23，超出候选有效期 → 无冲突
  assert.deepEqual(c2.check(candidate), { ok: true });
});

test("跨午夜窗口相交", () => {
  const c = new ScheduleChecker();
  // 既有：周一 22:00 开放，次日 02:00 截止
  c.loadPublished([
    base({ id: "a", openMinute: 1320, closeMinute: 120, closeNextDay: true }),
  ]);
  // 候选：周二 01:00-03:00
  const cand = base({
    id: "cand",
    weekdays: [2],
    openMinute: 60,
    closeMinute: 180,
  });
  const r = c.check(cand);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.candidateOpenDate, "2024-01-02");
    assert.equal(r.existingOpenDate, "2024-01-01");
    // 相交开始 = max(周二01:00, 周一22:00) = 周二 01:00 CST = 07:00Z
    assert.equal(r.earliestInstantUtc, "2024-01-02T07:00:00Z");
  }
});

test("周日-周一跨周相邻场次", () => {
  const c = new ScheduleChecker();
  // 既有：周日 23:00 开放，次日 01:00 截止
  c.loadPublished([
    base({
      id: "a",
      weekdays: [7],
      openMinute: 1380,
      closeMinute: 60,
      closeNextDay: true,
    }),
  ]);
  // 候选：周一 00:30-02:00
  const cand = base({ id: "cand", openMinute: 30, closeMinute: 120 });
  const r = c.check(cand);
  assert.equal(r.ok, false);
  if (!r.ok) {
    // 既有有效期自 2024-01-01 起，第一个周日场次为 2024-01-07
    assert.equal(r.candidateOpenDate, "2024-01-08"); // 周一
    assert.equal(r.existingOpenDate, "2024-01-07"); // 前一日周日
    assert.equal(r.earliestInstantUtc, "2024-01-08T06:30:00Z"); // 周一 00:30 CST
  }
});

test("有效期外的场次不参与", () => {
  const c = new ScheduleChecker();
  // 既有：2024 全年周一 10:00-12:00
  c.loadPublished([base({ id: "a" })]);
  // 候选：2025 年周一 10:00-12:00 → 不相交
  assert.deepEqual(
    c.check(
      base({
        id: "cand",
        validFrom: "2025-01-06",
        validTo: "2025-12-29",
        anchorMonday: "2025-01-06",
      }),
    ),
    { ok: true },
  );
});

test("截止可跨出有效期", () => {
  const c = new ScheduleChecker();
  // 既有：仅 2024-01-01 有效，周一 23:00 开放次日 01:00 截止
  c.loadPublished([
    base({
      id: "a",
      validFrom: "2024-01-01",
      validTo: "2024-01-01",
      openMinute: 1380,
      closeMinute: 60,
      closeNextDay: true,
    }),
  ]);
  // 候选：周二 00:30-02:00，2024 全年
  const r = c.check(
    base({ id: "cand", weekdays: [2], openMinute: 30, closeMinute: 120 }),
  );
  assert.equal(r.ok, false);
});

test("锚点周之前不生成场次", () => {
  const c = new ScheduleChecker();
  // 既有锚点 2024-06-03（周一），有效期从 1 月开始 → 6 月前无场次
  c.loadPublished([
    base({ id: "a", anchorMonday: "2024-06-03", openMinute: 600 }),
  ]);
  const cand = base({
    id: "cand",
    validFrom: "2024-01-01",
    validTo: "2024-03-31",
    openMinute: 600,
  });
  assert.deepEqual(c.check(cand), { ok: true });
});

test("N 周间隔只对齐锚点周", () => {
  const c = new ScheduleChecker();
  // 既有：每 2 周，锚点 2024-01-01 → 场次周 01-01, 01-15, 01-29 ...
  c.loadPublished([base({ id: "a", intervalWeeks: 2 })]);
  // 候选：仅 2024-01-08 至 2024-01-13 有效（错开周）→ 无冲突
  const miss = base({
    id: "cand",
    validFrom: "2024-01-08",
    validTo: "2024-01-13",
    anchorMonday: "2024-01-08",
  });
  assert.deepEqual(c.check(miss), { ok: true });
  // 候选：仅 2024-01-15 至 2024-01-20 → 命中
  const hit = base({
    id: "cand",
    validFrom: "2024-01-15",
    validTo: "2024-01-20",
    anchorMonday: "2024-01-15",
  });
  assert.equal(c.check(hit).ok, false);
});

test("最早冲突取全有效期最早瞬间", () => {
  const c = new ScheduleChecker();
  c.loadPublished([
    base({ id: "late", anchorMonday: "2024-03-04", validFrom: "2024-03-01", openMinute: 600 }),
    base({ id: "early", anchorMonday: "2024-02-05", validFrom: "2024-02-01", openMinute: 600 }),
  ]);
  const r = c.check(base({ id: "cand", openMinute: 600 }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.existingScheduleId, "early");
    assert.equal(r.earliestInstantUtc, "2024-02-05T16:00:00Z");
  }
});

test("检查不改变已发布数据", () => {
  const c = new ScheduleChecker();
  const published = base({ id: "a" });
  c.loadPublished([published]);
  const before = c.size;
  c.check(base({ id: "cand", openMinute: 600 }));
  c.check(base({ id: "cand2", openMinute: 660 }));
  assert.equal(c.size, before);
  // 再次检查结果一致
  const r1 = c.check(base({ id: "cand3", openMinute: 600 }));
  const r2 = c.check(base({ id: "cand4", openMinute: 600 }));
  assert.deepEqual(r1, r2);
});

test("非法输入抛错", () => {
  const c = new ScheduleChecker();
  assert.throws(() => c.loadPublished([base({ anchorMonday: "2024-01-02" })])); // 周二
  assert.throws(() => c.loadPublished([base({ intervalWeeks: 0 })]));
  assert.throws(() => c.loadPublished([base({ intervalWeeks: 53 })]));
  assert.throws(() => c.loadPublished([base({ skuIds: Array(9).fill("x") })]));
  assert.throws(() => c.loadPublished([base({ excludedDates: Array(65).fill("2024-01-01") })]));
  assert.throws(() => c.loadPublished([base({ openMinute: 600, closeMinute: 600 })]));
  assert.throws(() => c.loadPublished([base({ validFrom: "2024-06-01", validTo: "2024-01-01" })]));
  assert.throws(() => c.loadPublished([base({ weekdays: [] })]));
});
