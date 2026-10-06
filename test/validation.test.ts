/** 输入校验：非法排期应当抛出错误。 */
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/index.js";
import type { ScheduleInput } from "../src/types.js";

function base(overrides: Partial<ScheduleInput>): ScheduleInput {
  return {
    id: "s",
    pickupPointId: "p1",
    skus: ["sku-1"],
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    anchorMonday: "2025-12-29",
    intervalWeeks: 1,
    weekdays: [0],
    openTime: "10:00",
    closeTime: "12:00",
    closeNextDay: false,
    ...overrides,
  };
}

describe("输入校验", () => {
  it("非法输入抛出错误", () => {
    const store = new ScheduleStore();
    const bad: Array<[string, Partial<ScheduleInput>]> = [
      ["SKU 超过 8 个", { skus: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }],
      ["SKU 为空", { skus: [] }],
      ["有效期颠倒", { validFrom: "2026-12-31", validTo: "2026-01-01" }],
      ["锚点不是周一", { anchorMonday: "2026-01-06" }],
      ["间隔为 0", { intervalWeeks: 0 }],
      ["间隔超过 52", { intervalWeeks: 53 }],
      ["星期几越界", { weekdays: [7] }],
      ["同日截止不晚于开放", { openTime: "10:00", closeTime: "10:00" }],
      ["年份小于 2008", { validFrom: "2007-12-31" }],
      ["不存在的日期", { validFrom: "2026-02-29" }],
      [
        "排除日期超过 64",
        {
          excludedDates: Array.from(
            { length: 65 },
            (_, i) => `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
          ),
        },
      ],
    ];
    for (const [label, patch] of bad) {
      expect(() => store.check(base(patch)), label).toThrow();
    }
  });

  it("合法边界输入通过", () => {
    const store = new ScheduleStore();
    const ok = base({
      skus: ["1", "2", "3", "4", "5", "6", "7", "8"],
      intervalWeeks: 52,
      weekdays: [0, 6],
      validFrom: "2008-01-01",
      validTo: "9999-12-31",
      anchorMonday: "2008-01-07",
      excludedDates: ["2026-03-08"],
    });
    expect(store.check(ok).canPublish).toBe(true);
  });
});
