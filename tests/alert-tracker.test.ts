import test from "node:test";
import assert from "node:assert/strict";
import { AlertTracker } from "../src/alert-tracker";
import { AlertInterval, ApplyResult, Outcome, Report, StreamKey } from "../src/types";

const STREAM: StreamKey = { deviceId: "dev-1", applicationId: "app-1" };

function report(seq: number, revision: number, outcome: Outcome): Report {
  return { ...STREAM, seq, revision, outcome };
}

function interval(start: number, end: number): AlertInterval {
  return { start, end };
}

function sorted(intervals: AlertInterval[]): AlertInterval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

function assertDiff(actual: ApplyResult, added: AlertInterval[], removed: AlertInterval[]) {
  assert.deepEqual(sorted(actual.added), sorted(added), "added");
  assert.deepEqual(sorted(actual.removed), sorted(removed), "removed");
}

function assertAlerts(tracker: AlertTracker, expected: AlertInterval[], stream: StreamKey = STREAM) {
  assert.deepEqual(sorted(tracker.listAlerts(stream)), sorted(expected), "listAlerts");
}

test("乱序形成 1-13 失败区间，校正拆分，过期/重复忽略，恢复合并", () => {
  const tracker = new AlertTracker();
  assertAlerts(tracker, []);

  // 乱序投递 1..13 的失败（revision=1）。
  const order = [5, 2, 9, 1, 13, 7, 3, 11, 4, 6, 10, 12, 8];
  const expectations: { added: AlertInterval[]; removed: AlertInterval[] }[] = [
    { added: [], removed: [] }, // 5
    { added: [], removed: [] }, // 2
    { added: [], removed: [] }, // 9
    { added: [], removed: [] }, // 1
    { added: [], removed: [] }, // 13
    { added: [], removed: [] }, // 7
    { added: [], removed: [] }, // 3
    { added: [], removed: [] }, // 11
    { added: [], removed: [] }, // 4 -> 1..5 仅 5 个
    { added: [interval(1, 7)], removed: [] }, // 6 -> 1..7 满 6 个
    { added: [], removed: [] }, // 10
    { added: [], removed: [] }, // 12
    { added: [interval(1, 13)], removed: [interval(1, 7)] }, // 8 -> 连通为 1..13
  ];
  order.forEach((seq, i) => {
    assertDiff(tracker.apply(report(seq, 1, "Failed")), expectations[i]!.added, expectations[i]!.removed);
  });
  assertAlerts(tracker, [interval(1, 13)]);

  // 更高 revision 把 7 校正为成功：拆成两个长度 6 的告警。
  assertDiff(
    tracker.apply(report(7, 2, "Installed")),
    [interval(1, 6), interval(8, 13)],
    [interval(1, 13)]
  );
  assertAlerts(tracker, [interval(1, 6), interval(8, 13)]);

  // 旧版本（rev 1 < 2）：忽略。
  assertDiff(tracker.apply(report(7, 1, "Failed")), [], []);
  // 重复版本（rev 2，内容一致）：忽略。
  assertDiff(tracker.apply(report(7, 2, "Installed")), [], []);
  // 其他序号的过期/重复上报：忽略。
  assertDiff(tracker.apply(report(3, 1, "Failed")), [], []);
  assertDiff(tracker.apply(report(3, 0, "Installed")), [], []);
  // 只提高 revision 但不改变有效状态：空差分。
  assertDiff(tracker.apply(report(5, 9, "Failed")), [], []);
  assertAlerts(tracker, [interval(1, 6), interval(8, 13)]);

  // 更高版本把 7 恢复为失败：重新合并为 1..13。
  assertDiff(
    tracker.apply(report(7, 3, "Failed")),
    [interval(1, 13)],
    [interval(1, 6), interval(8, 13)]
  );
  assertAlerts(tracker, [interval(1, 13)]);
});

test("缺失序号不能跨缺口合并", () => {
  const tracker = new AlertTracker();
  // 1..6 与 8..13 失败，7 从未上报（未知）。
  for (const seq of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) {
    tracker.apply(report(seq, 1, "Failed"));
  }
  assertAlerts(tracker, [interval(1, 6), interval(8, 13)]);

  // 7 上报为成功：区间不变。
  assertDiff(tracker.apply(report(7, 1, "Installed")), [], []);
  assertAlerts(tracker, [interval(1, 6), interval(8, 13)]);

  // 7 校正为失败后才允许合并。
  assertDiff(
    tracker.apply(report(7, 2, "Failed")),
    [interval(1, 13)],
    [interval(1, 6), interval(8, 13)]
  );
  assertAlerts(tracker, [interval(1, 13)]);
});

test("长度不足 6 的连续失败不产生告警", () => {
  const tracker = new AlertTracker();
  for (let seq = 1; seq <= 5; seq++) {
    assertDiff(tracker.apply(report(seq, 1, "Failed")), [], []);
  }
  assertAlerts(tracker, []);
  assertDiff(tracker.apply(report(6, 1, "Failed")), [interval(1, 6)], []);
});

test("未知流返回空告警列表", () => {
  const tracker = new AlertTracker();
  assert.deepEqual(tracker.listAlerts({ deviceId: "nobody", applicationId: "nothing" }), []);
});
