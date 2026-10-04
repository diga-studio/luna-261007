import { test } from "node:test";
import assert from "node:assert/strict";
import { EventRecord, SessionStore } from "../src/index";

const MIN = 60 * 1000;
const GAP = 30 * MIN;
const T0 = 1_700_000_000_000;

function ev(eventId: string, offsetMs: number, screen = "Home", userId = "u1"): EventRecord {
  return { eventId, userId, timestampMs: T0 + offsetMs, screen };
}

function ids(events: EventRecord[] | undefined): string[] {
  assert.ok(events !== undefined);
  return events.map((e) => e.eventId);
}

test("乱序补传连接两段会话", () => {
  const store = new SessionStore();
  // 先写入两段互不相邻的会话：A 段在 0/10 分钟，B 段在 50/60 分钟。
  store.writeBatch([
    ev("a1", 0, "List"),
    ev("a2", 10 * MIN, "Detail"),
    ev("b1", 50 * MIN, "Cart"),
    ev("b2", 60 * MIN, "Pay"),
  ]);
  assert.equal(store.getSessionSummary("a1")!.eventCount, 2);
  assert.equal(store.getSessionSummary("b1")!.eventCount, 2);
  assert.notEqual(
    store.getSessionSummary("a1")!.sessionId,
    store.getSessionSummary("b1")!.sessionId,
  );

  // 离线补传一条 25 分钟处的事件（时间早于已上传的 b 段），把两段连起来。
  store.writeBatch([ev("bridge", 25 * MIN, "Search")]);

  const summary = store.getSessionSummary("a1")!;
  assert.equal(summary.eventCount, 5);
  assert.equal(summary.startMs, T0);
  assert.equal(summary.endMs, T0 + 60 * MIN);
  assert.equal(summary.durationMs, 60 * MIN);
  assert.equal(summary.entryScreen, "List");
  assert.equal(summary.exitScreen, "Pay");
  assert.equal(summary.sessionId, store.getSessionSummary("b2")!.sessionId);
  assert.deepEqual(ids(store.getSessionEvents("bridge")), ["a1", "a2", "bridge", "b1", "b2"]);
});

test("桥接事件移走后旧位置拆分、新位置合并", () => {
  const store = new SessionStore();
  // bridge 在 25 分钟处把 a 段（0/10）与 b 段（50/60）连成一段；
  // 另有 c 段（200/210）独立存在。
  store.writeBatch([
    ev("a1", 0, "List"),
    ev("a2", 10 * MIN, "Detail"),
    ev("bridge", 25 * MIN, "Search"),
    ev("b1", 50 * MIN, "Cart"),
    ev("b2", 60 * MIN, "Pay"),
    ev("c1", 200 * MIN, "Home"),
    ev("c2", 210 * MIN, "Profile"),
  ]);
  assert.equal(store.getSessionSummary("a1")!.eventCount, 5);
  assert.equal(store.getSessionSummary("c1")!.eventCount, 2);

  // 修订：bridge 改到 195 分钟处（同时换屏幕）。
  // 旧位置：a 段（0/10）与 b 段（50/60）之间间隔 40 分钟，拆成两段；
  // 新位置：195 与 c1(200)、c2(210) 间隔均 < 30 分钟，合并成一段。
  store.writeBatch([ev("bridge", 195 * MIN, "SearchV2")]);

  const aSummary = store.getSessionSummary("a1")!;
  assert.equal(aSummary.eventCount, 2);
  assert.deepEqual(ids(store.getSessionEvents("a1")), ["a1", "a2"]);
  assert.equal(aSummary.exitScreen, "Detail");

  const bSummary = store.getSessionSummary("b1")!;
  assert.equal(bSummary.eventCount, 2);
  assert.deepEqual(ids(store.getSessionEvents("b2")), ["b1", "b2"]);
  assert.notEqual(aSummary.sessionId, bSummary.sessionId);

  const cSummary = store.getSessionSummary("bridge")!;
  assert.equal(cSummary.eventCount, 3);
  assert.equal(cSummary.entryScreen, "SearchV2");
  assert.equal(cSummary.exitScreen, "Profile");
  assert.equal(cSummary.durationMs, 15 * MIN);
  assert.deepEqual(ids(store.getSessionEvents("c1")), ["bridge", "c1", "c2"]);
});

test("重复写入相同记录不增加事件数", () => {
  const store = new SessionStore();
  const record = ev("e1", 0, "Home");
  store.writeBatch([record, { ...record }]);
  store.writeBatch([{ ...record }]);
  const summary = store.getSessionSummary("e1")!;
  assert.equal(summary.eventCount, 1);
  assert.equal(summary.durationMs, 0);
  assert.deepEqual(ids(store.getSessionEvents("e1")), ["e1"]);
});

test("同 ID 修订可改变时间戳和屏幕", () => {
  const store = new SessionStore();
  store.writeBatch([ev("e1", 0, "Home"), ev("e2", 5 * MIN, "List")]);
  store.writeBatch([ev("e2", 2 * MIN, "Search")]);
  const summary = store.getSessionSummary("e1")!;
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.entryScreen, "Home");
  assert.equal(summary.exitScreen, "Search");
  assert.deepEqual(ids(store.getSessionEvents("e1")), ["e1", "e2"]);
});

test("30 分钟边界：严格小于同会话，达到即切开", () => {
  const store = new SessionStore();
  store.writeBatch([
    ev("x1", 0),
    ev("x2", GAP - 1),
    ev("x3", GAP - 1 + GAP),
  ]);
  assert.equal(store.getSessionSummary("x1")!.eventCount, 2);
  assert.equal(store.getSessionSummary("x3")!.eventCount, 1);
  assert.notEqual(
    store.getSessionSummary("x2")!.sessionId,
    store.getSessionSummary("x3")!.sessionId,
  );
});

test("链式会话总时长可远大于 30 分钟", () => {
  const store = new SessionStore();
  const records: EventRecord[] = [];
  for (let i = 0; i < 10; i += 1) {
    records.push(ev(`c${i}`, i * 10 * MIN));
  }
  store.writeBatch(records);
  const summary = store.getSessionSummary("c0")!;
  assert.equal(summary.eventCount, 10);
  assert.equal(summary.durationMs, 90 * MIN);
});

test("同毫秒事件按事件 ID 的 ASCII 字典序排列", () => {
  const store = new SessionStore();
  store.writeBatch([ev("b", 0, "SB"), ev("A", 0, "SA"), ev("a", 0, "Sa")]);
  assert.deepEqual(ids(store.getSessionEvents("A")), ["A", "a", "b"]);
  const summary = store.getSessionSummary("A")!;
  assert.equal(summary.entryScreen, "SA");
  assert.equal(summary.exitScreen, "SB");
});

test("同屏幕连续事件不折叠", () => {
  const store = new SessionStore();
  store.writeBatch([
    ev("s1", 0, "Home"),
    ev("s2", 1 * MIN, "Home"),
    ev("s3", 2 * MIN, "Home"),
  ]);
  const events = store.getSessionEvents("s1")!;
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.screen), ["Home", "Home", "Home"]);
});

test("批内记录顺序不影响最终结果", () => {
  const records = [
    ev("m1", 0, "A"),
    ev("m2", 5 * MIN, "B"),
    ev("m3", 40 * MIN, "C"),
    ev("m4", 45 * MIN, "D"),
    ev("m5", 20 * MIN, "E"),
  ];
  const forward = new SessionStore();
  forward.writeBatch(records);
  const reversed = new SessionStore();
  reversed.writeBatch([...records].reverse());
  const shuffled = new SessionStore();
  shuffled.writeBatch([records[2], records[4], records[0], records[3], records[1]]);
  for (const id of ["m1", "m3", "m5"]) {
    assert.deepEqual(reversed.getSessionSummary(id), forward.getSessionSummary(id));
    assert.deepEqual(shuffled.getSessionSummary(id), forward.getSessionSummary(id));
    assert.deepEqual(shuffled.getSessionEvents(id), forward.getSessionEvents(id));
  }
  assert.equal(forward.getSessionSummary("m1")!.eventCount, 5);
});

test("多用户互不影响", () => {
  const store = new SessionStore();
  store.writeBatch([ev("u1e1", 0, "Home", "u1"), ev("u2e1", 0, "Home", "u2")]);
  store.writeBatch([ev("u1e2", 5 * MIN, "List", "u1")]);
  assert.equal(store.getSessionSummary("u1e1")!.eventCount, 2);
  assert.equal(store.getSessionSummary("u2e1")!.eventCount, 1);
  assert.equal(store.getSessionSummary("u1e1")!.userId, "u1");
});

test("查询不存在的事件返回 undefined", () => {
  const store = new SessionStore();
  assert.equal(store.getSessionSummary("nope"), undefined);
  assert.equal(store.getSessionEvents("nope"), undefined);
});

test("返回的事件序列是副本，外部修改不影响内部状态", () => {
  const store = new SessionStore();
  store.writeBatch([ev("e1", 0, "Home")]);
  const events = store.getSessionEvents("e1")!;
  events[0].screen = "Tampered";
  events.length = 0;
  assert.equal(store.getSessionSummary("e1")!.entryScreen, "Home");
  assert.equal(store.getSessionEvents("e1")!.length, 1);
});
