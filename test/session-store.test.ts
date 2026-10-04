import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore, SESSION_GAP_MS } from "../src/index";
import type { EventRecord } from "../src/index";

const MIN = 60 * 1000;
const BASE = 1_700_000_000_000;

function ev(eventId: string, minute: number, screen: string, userId = "u1"): EventRecord {
  return { eventId, userId, timestampMs: BASE + minute * MIN, screen };
}

test("乱序补传连接两段会话", () => {
  const store = new SessionStore();
  // 同一批内乱序写入两段相隔超过 30 分钟的历史事件。
  store.writeBatch([
    ev("b2", 70, "checkout"),
    ev("a2", 10, "detail"),
    ev("b1", 60, "cart"),
    ev("a1", 0, "home"),
  ]);
  assert.equal(store.getSessionSummary("a1")?.eventCount, 2);
  assert.equal(store.getSessionSummary("b1")?.eventCount, 2);

  // 离线补传一条很早的事件，恰好落在两段之间，把两段连成一段。
  store.writeBatch([ev("bridge", 35, "search")]);

  const summary = store.getSessionSummary("a1");
  assert.ok(summary);
  assert.equal(summary.eventCount, 5);
  assert.equal(summary.startTimeMs, BASE);
  assert.equal(summary.endTimeMs, BASE + 70 * MIN);
  assert.equal(summary.durationMs, 70 * MIN);
  assert.equal(summary.entryScreen, "home");
  assert.equal(summary.exitScreen, "checkout");

  // 同一会话：从任意事件查询都得到同一摘要与完整序列。
  assert.deepEqual(store.getSessionSummary("b2"), summary);
  const events = store.getSessionEvents("bridge");
  assert.ok(events);
  assert.deepEqual(
    events.map((e) => e.eventId),
    ["a1", "a2", "bridge", "b1", "b2"],
  );
});

test("修订桥接事件时间：旧位置拆分、新位置合并", () => {
  const store = new SessionStore();
  store.writeBatch([
    ev("a1", 0, "home"),
    ev("a2", 10, "detail"),
    ev("bridge", 35, "search"),
    ev("b1", 60, "cart"),
    ev("b2", 70, "checkout"),
    ev("d1", 220, "settings"),
  ]);
  assert.equal(store.getSessionSummary("a1")?.eventCount, 5);
  assert.equal(store.getSessionSummary("d1")?.eventCount, 1);

  // 把桥接事件从 35 分钟处改到 200 分钟处。
  store.writeBatch([ev("bridge", 200, "search")]);

  // 旧位置拆开为原来的两段。
  const s1 = store.getSessionSummary("a1");
  assert.ok(s1);
  assert.equal(s1.eventCount, 2);
  assert.equal(s1.entryScreen, "home");
  assert.equal(s1.exitScreen, "detail");
  const s2 = store.getSessionSummary("b1");
  assert.ok(s2);
  assert.equal(s2.eventCount, 2);
  assert.equal(s2.entryScreen, "cart");
  assert.equal(s2.exitScreen, "checkout");
  assert.notEqual(s1.sessionId, s2.sessionId);

  // 新位置与 d1 合并成一段。
  const s3 = store.getSessionSummary("bridge");
  assert.ok(s3);
  assert.equal(s3.eventCount, 2);
  assert.equal(s3.entryScreen, "search");
  assert.equal(s3.exitScreen, "settings");
  assert.deepEqual(
    store.getSessionEvents("d1")?.map((e) => e.eventId),
    ["bridge", "d1"],
  );
});

test("重复写入相同记录不增加事件数", () => {
  const store = new SessionStore();
  const record = ev("e1", 0, "home");
  store.writeBatch([record]);
  store.writeBatch([record]);
  store.writeBatch([{ ...record }]);
  assert.equal(store.getSessionSummary("e1")?.eventCount, 1);
  assert.equal(store.getSessionEvents("e1")?.length, 1);
});

test("同 ID 覆盖可修改时间与屏幕", () => {
  const store = new SessionStore();
  store.writeBatch([ev("e1", 0, "home"), ev("e2", 10, "detail")]);
  store.writeBatch([ev("e1", 5, "landing")]);
  const events = store.getSessionEvents("e2");
  assert.ok(events);
  assert.deepEqual(
    events.map((e) => [e.eventId, e.screen, e.timestampMs - BASE]),
    [
      ["e1", "landing", 5 * MIN],
      ["e2", "detail", 10 * MIN],
    ],
  );
  assert.equal(store.getSessionSummary("e2")?.entryScreen, "landing");
});

test("间隔恰好 30 分钟切开，小于 30 分钟不切", () => {
  const store = new SessionStore();
  store.writeBatch([
    { eventId: "e1", userId: "u1", timestampMs: BASE, screen: "s1" },
    { eventId: "e2", userId: "u1", timestampMs: BASE + SESSION_GAP_MS - 1, screen: "s2" },
    { eventId: "e3", userId: "u1", timestampMs: BASE + 2 * SESSION_GAP_MS - 1, screen: "s3" },
  ]);
  assert.equal(store.getSessionSummary("e1")?.eventCount, 2);
  assert.equal(store.getSessionSummary("e3")?.eventCount, 1);
});

test("同毫秒事件按事件 ID 的 ASCII 字典序排列", () => {
  const store = new SessionStore();
  store.writeBatch([
    { eventId: "b", userId: "u1", timestampMs: BASE, screen: "screen-b" },
    { eventId: "a", userId: "u1", timestampMs: BASE, screen: "screen-a" },
    { eventId: "A", userId: "u1", timestampMs: BASE, screen: "screen-A" },
  ]);
  const events = store.getSessionEvents("a");
  assert.ok(events);
  assert.deepEqual(events.map((e) => e.eventId), ["A", "a", "b"]);
  assert.equal(store.getSessionSummary("b")?.entryScreen, "screen-A");
});

test("同屏幕连续事件不折叠，单事件会话时长为零", () => {
  const store = new SessionStore();
  store.writeBatch([ev("e1", 0, "home"), ev("e2", 1, "home"), ev("e3", 2, "home")]);
  const events = store.getSessionEvents("e1");
  assert.ok(events);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.screen === "home"));

  const solo = new SessionStore();
  solo.writeBatch([ev("x", 0, "only")]);
  const summary = solo.getSessionSummary("x");
  assert.ok(summary);
  assert.equal(summary.durationMs, 0);
  assert.equal(summary.startTimeMs, summary.endTimeMs);
});

test("会话总时长可以远大于 30 分钟", () => {
  const store = new SessionStore();
  const records: EventRecord[] = [];
  for (let i = 0; i < 10; i += 1) {
    records.push(ev(`e${i}`, i * 29, `s${i}`));
  }
  store.writeBatch(records);
  const summary = store.getSessionSummary("e0");
  assert.ok(summary);
  assert.equal(summary.eventCount, 10);
  assert.equal(summary.durationMs, 9 * 29 * MIN);
});

test("批内写入顺序不影响最终结果", () => {
  const records = [
    ev("a1", 0, "home"),
    ev("a2", 10, "detail"),
    ev("bridge", 35, "search"),
    ev("b1", 60, "cart"),
    ev("b2", 70, "checkout"),
  ];
  const forward = new SessionStore();
  forward.writeBatch(records);
  const reverse = new SessionStore();
  reverse.writeBatch([...records].reverse());
  const shuffled = new SessionStore();
  shuffled.writeBatch([records[2], records[4], records[0], records[3], records[1]]);
  for (const id of ["a1", "a2", "bridge", "b1", "b2"]) {
    assert.deepEqual(shuffled.getSessionSummary(id), forward.getSessionSummary(id));
    assert.deepEqual(reverse.getSessionSummary(id), forward.getSessionSummary(id));
    assert.deepEqual(
      shuffled.getSessionEvents(id)?.map((e) => e.eventId),
      forward.getSessionEvents(id)?.map((e) => e.eventId),
    );
  }
});

test("不同用户互不影响，未知事件返回 null", () => {
  const store = new SessionStore();
  store.writeBatch([ev("e1", 0, "home", "u1"), ev("e2", 5, "home", "u2")]);
  assert.equal(store.getSessionSummary("e1")?.eventCount, 1);
  assert.equal(store.getSessionSummary("e2")?.eventCount, 1);
  assert.equal(store.getSessionSummary("missing"), null);
  assert.equal(store.getSessionEvents("missing"), null);
});
