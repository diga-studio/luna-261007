/** 验收场景：边界语义、DST 特例、排除日、远期冲突。 */
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/index.js";
import type { ScheduleInput } from "../src/types.js";
import { daysFromCivil, fallBackDay, springForwardDay } from "../src/calendar.js";

function base(overrides: Partial<ScheduleInput>): ScheduleInput {
  return {
    id: "s",
    pickupPointId: "p1",
    skus: ["sku-1"],
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    anchorMonday: "2025-12-29", // 周一
    intervalWeeks: 1,
    weekdays: [0],
    openTime: "10:00",
    closeTime: "12:00",
    closeNextDay: false,
    ...overrides,
  };
}

describe("边界语义", () => {
  it("窗口首尾相接不冲突", () => {
    const store = new ScheduleStore([base({ id: "b", openTime: "12:00", closeTime: "14:00" })]);
    const result = store.check(base({ id: "a", openTime: "10:00", closeTime: "12:00" }));
    expect(result.canPublish).toBe(true);
  });

  it("不同取货点不冲突", () => {
    const store = new ScheduleStore([base({ id: "b" })]);
    expect(store.check(base({ id: "a", pickupPointId: "p2" })).canPublish).toBe(true);
  });

  it("不共享 SKU 不冲突", () => {
    const store = new ScheduleStore([base({ id: "b", skus: ["sku-2"] })]);
    expect(store.check(base({ id: "a", skus: ["sku-1"] })).canPublish).toBe(true);
  });

  it("完全重合的窗口冲突，最早瞬间为较晚开放时刻", () => {
    const store = new ScheduleStore([base({ id: "b", openTime: "11:00", closeTime: "13:00" })]);
    const result = store.check(base({ id: "a", openTime: "10:00", closeTime: "12:00" }));
    expect(result.canPublish).toBe(false);
    // 有效期自 2026-01-01 起，首个共同周一为 2026-01-05，11:00 CST = 17:00 UTC
    const expected = daysFromCivil(2026, 1, 5) * 1440 + 11 * 60 + 360;
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(expected);
    expect(result.conflict?.existingScheduleId).toBe("b");
    expect(result.conflict?.sharedSku).toBe("sku-1");
    expect(result.conflict?.pendingOpenDate).toBe("2026-01-05");
    expect(result.conflict?.existingOpenDate).toBe("2026-01-05");
  });

  it("检查不改变已发布数据", () => {
    const input = base({ id: "b" });
    const store = new ScheduleStore([input]);
    const before = store.count;
    store.check(base({ id: "a" }));
    store.check(base({ id: "a2" }));
    expect(store.count).toBe(before);
    // 再次装入不同集合后结果随之改变
    store.load([base({ id: "c", skus: ["sku-9"] })]);
    expect(store.check(base({ id: "a3" })).canPublish).toBe(true);
  });
});

describe("有效期末尾唯一冲突", () => {
  // A：全年每周一 10:00-12:00；B：N=52 锚在 2026-12-28（年内唯一场次），11:00-13:00。
  // 两条有效期几乎完全重合，唯一冲突在 A 有效期最后一个可生成场次 2026-12-28。
  const a = base({ id: "a", validFrom: "2026-01-01", validTo: "2026-12-31" });
  const b = base({
    id: "b",
    anchorMonday: "2026-12-28",
    intervalWeeks: 52,
    openTime: "11:00",
    closeTime: "13:00",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  });

  it("唯一冲突落在有效期最后一个可生成场次", () => {
    const store = new ScheduleStore([b]);
    const result = store.check(a);
    expect(result.canPublish).toBe(false);
    // 2026-12-28 11:00 CST = 17:00 UTC
    const expected = daysFromCivil(2026, 12, 28) * 1440 + 11 * 60 + 360;
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(expected);
    expect(result.conflict?.pendingOpenDate).toBe("2026-12-28");
    expect(result.conflict?.existingOpenDate).toBe("2026-12-28");
  });

  it("排除该场后不再冲突", () => {
    const store = new ScheduleStore([b]);
    const result = store.check({ ...a, excludedDates: ["2026-12-28"] });
    expect(result.canPublish).toBe(true);
  });

  it("既有方排除该场后也不再冲突", () => {
    const store = new ScheduleStore([{ ...b, excludedDates: ["2026-12-28"] }]);
    expect(store.check(a).canPublish).toBe(true);
  });
});

describe("春季缺失时刻", () => {
  const spring = springForwardDay(2026); // 2026-03-08
  const validFrom = "2026-03-02";
  const validTo = "2026-03-13"; // 只覆盖 3 月 8 日这个周日
  const anchor = "2026-03-02"; // 周一

  it("开放落在缺失时刻使整场取消", () => {
    const store = new ScheduleStore([
      base({
        id: "b",
        weekdays: [6],
        anchorMonday: anchor,
        validFrom,
        validTo,
        openTime: "01:00",
        closeTime: "04:00",
      }),
    ]);
    // A 开放 02:30 在春季缺口中 -> 取消 -> 无冲突
    const result = store.check(
      base({ id: "a", weekdays: [6], anchorMonday: anchor, validFrom, validTo, openTime: "02:30", closeTime: "03:30" }),
    );
    expect(result.canPublish).toBe(true);
  });

  it("截止落在缺失时刻同样使整场取消", () => {
    const store = new ScheduleStore([
      base({ id: "b", weekdays: [6], anchorMonday: anchor, validFrom, validTo, openTime: "01:00", closeTime: "04:00" }),
    ]);
    const result = store.check(
      base({ id: "a", weekdays: [6], anchorMonday: anchor, validFrom, validTo, openTime: "01:30", closeTime: "02:30" }),
    );
    expect(result.canPublish).toBe(true);
  });

  it("未缺失时同一对排期冲突", () => {
    const store = new ScheduleStore([
      base({ id: "b", weekdays: [6], anchorMonday: anchor, validFrom, validTo, openTime: "01:00", closeTime: "04:00" }),
    ]);
    const result = store.check(
      base({ id: "a", weekdays: [6], anchorMonday: anchor, validFrom, validTo, openTime: "01:30", closeTime: "03:30" }),
    );
    expect(result.canPublish).toBe(false);
    // A 开放 01:30 CST = 07:30 UTC；B 开放 01:00 CST = 07:00 UTC -> 相交起点 07:30
    const expected = spring * 1440 + 7 * 60 + 30;
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(expected);
  });
});

describe("秋季重复小时", () => {
  const fall = fallBackDay(2026); // 2026-11-01
  const validFrom = "2026-10-26";
  const validTo = "2026-11-08"; // 只覆盖 11 月 1 日这个周日
  const anchor = "2026-10-26"; // 周一

  it("钟面不相交的两段窗口在真实时间上相交", () => {
    // A：01:00-01:30（开放取较早 06:00 UTC，截止取较晚 07:30 UTC）
    // B：01:45-02:30（开放取较早 06:45 UTC，截止 08:30 UTC）
    // 钟面上 [01:00,01:30) 与 [01:45,02:30) 不相交，真实时间相交于 06:45 UTC。
    const store = new ScheduleStore([
      base({ id: "b", weekdays: [6], anchorMonday: anchor, validFrom, validTo, openTime: "01:45", closeTime: "02:30" }),
    ]);
    const result = store.check(
      base({ id: "a", weekdays: [6], anchorMonday: anchor, validFrom, validTo, openTime: "01:00", closeTime: "01:30" }),
    );
    expect(result.canPublish).toBe(false);
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(fall * 1440 + 6 * 60 + 45);
    expect(result.conflict?.earliestOverlapStartIsoUtc).toBe("2026-11-01T06:45:00Z");
    expect(result.conflict?.pendingOpenDate).toBe("2026-11-01");
    expect(result.conflict?.existingOpenDate).toBe("2026-11-01");
  });

  it("非重复日同一对钟面窗口不冲突", () => {
    // 同样的钟面窗口放在普通周日（11 月 8 日）则不冲突
    const store = new ScheduleStore([
      base({ id: "b", weekdays: [6], anchorMonday: anchor, validFrom: "2026-11-02", validTo, openTime: "01:45", closeTime: "02:30" }),
    ]);
    const result = store.check(
      base({ id: "a", weekdays: [6], anchorMonday: anchor, validFrom: "2026-11-02", validTo, openTime: "01:00", closeTime: "01:30" }),
    );
    expect(result.canPublish).toBe(true);
  });
});

describe("远期冲突", () => {
  it("冲突发生在多年之后也能被发现", () => {
    // A：每周一 10:00-12:00，有效期到 9999 年
    const a = base({ id: "a", validFrom: "2026-01-01", validTo: "9999-12-31" });
    // B：N=52，锚在 2035-01-01 所在周的周一，年内唯一场次 2035-01-01 是周一？
    // 直接选 2035-06-14（周四）作为开放日：取锚为该周周一 2035-06-11，weekdays=[3]
    const b = base({
      id: "b",
      anchorMonday: "2035-06-11",
      intervalWeeks: 52,
      weekdays: [0], // 周一 2035-06-11
      openTime: "11:00",
      closeTime: "13:00",
      validFrom: "2026-01-01",
      validTo: "9999-12-31",
    });
    // A 在 2035-06-11 有场次（周一），与 B 冲突于 11:00 CDT = 16:00 UTC
    const store = new ScheduleStore([b]);
    const result = store.check(a);
    expect(result.canPublish).toBe(false);
    const expected = daysFromCivil(2035, 6, 11) * 1440 + 11 * 60 + 300;
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(expected);
    expect(result.conflict?.pendingOpenDate).toBe("2035-06-11");
  });
});

describe("长有效期求解", () => {
  it("远未来（8888 年）的秋季重复小时冲突", () => {
    // 与“秋季重复小时”相同的钟面格局，但有效期自 8888 年开始，
    // 检验跨年同余求解能定位到 8888 年的第一个秋季转换日。
    const store = new ScheduleStore([
      base({
        id: "b",
        weekdays: [6],
        anchorMonday: "8888-05-31",
        validFrom: "8888-06-01",
        validTo: "9999-12-31",
        openTime: "01:45",
        closeTime: "02:30",
      }),
    ]);
    const result = store.check(
      base({
        id: "a",
        weekdays: [6],
        anchorMonday: "8888-05-31",
        validFrom: "8888-06-01",
        validTo: "9999-12-31",
        openTime: "01:00",
        closeTime: "01:30",
      }),
    );
    expect(result.canPublish).toBe(false);
    const fall = fallBackDay(8888);
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(fall * 1440 + 6 * 60 + 45);
    expect(result.conflict?.pendingOpenDate).toBe(
      `${"8888"}-${String(11).padStart(2, "0")}-${String(7).padStart(2, "0")}`,
    );
  });

  it("首个共同周日被春季缺口取消时顺延到下一周", () => {
    // A：周日 02:30-03:30（2026-03-08 开放在缺口中，取消）
    // B：周日 03:00-04:00，首个共同周日即 2026-03-08，冲突应顺延至 2026-03-15
    const store = new ScheduleStore([
      base({
        id: "b",
        weekdays: [6],
        anchorMonday: "2026-03-02",
        validFrom: "2026-03-02",
        validTo: "2026-03-31",
        openTime: "03:00",
        closeTime: "04:00",
      }),
    ]);
    const result = store.check(
      base({
        id: "a",
        weekdays: [6],
        anchorMonday: "2026-03-02",
        validFrom: "2026-03-02",
        validTo: "2026-03-31",
        openTime: "02:30",
        closeTime: "03:30",
      }),
    );
    expect(result.canPublish).toBe(false);
    // 2026-03-15 03:00 CDT = 08:00 UTC
    const expected = daysFromCivil(2026, 3, 15) * 1440 + 8 * 60;
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(expected);
    expect(result.conflict?.pendingOpenDate).toBe("2026-03-15");
  });
});

describe("特殊格局排除顺延", () => {
  it("秋季重复小时冲突被排除后顺延到下一个秋季转换日", () => {
    const mk = (id: string, openTime: string, closeTime: string, excludedDates?: string[]) =>
      base({
        id,
        weekdays: [6],
        anchorMonday: "2026-10-26",
        validFrom: "2026-10-01",
        validTo: "2028-12-31",
        openTime,
        closeTime,
        excludedDates,
      });
    const a = mk("a", "01:00", "01:30", ["2026-11-01"]);
    const b = mk("b", "01:45", "02:30");
    const store = new ScheduleStore([b]);
    const result = store.check(a);
    expect(result.canPublish).toBe(false);
    // 2026-11-01 被排除，顺延到 2027 年秋季转换日 2027-11-07，06:45 UTC
    const fall2027 = fallBackDay(2027);
    expect(result.conflict?.earliestOverlapStartMinutesUtc).toBe(fall2027 * 1440 + 6 * 60 + 45);
    expect(result.conflict?.pendingOpenDate).toBe("2027-11-07");
  });
});
