import test from "node:test";
import assert from "node:assert/strict";
import { AlertTracker } from "../src/index.js";
import type {
  AlertDiff,
  AlertInterval,
  Outcome,
  StreamKey,
} from "../src/index.js";

const S1: StreamKey = { deviceId: "dev-1", applicationId: "app-1" };
const S2: StreamKey = { deviceId: "dev-2", applicationId: "app-1" };
const S3: StreamKey = { deviceId: "dev-3", applicationId: "app-1" };

function report(
  stream: StreamKey,
  seq: number,
  revision: number,
  outcome: Outcome,
) {
  return { ...stream, seq, revision, outcome };
}

function iv(start: number, end: number): AlertInterval {
  return { start, end };
}

function normalize(intervals: AlertInterval[]): AlertInterval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

function assertDiff(actual: AlertDiff, added: AlertInterval[], removed: AlertInterval[]) {
  assert.deepEqual(normalize(actual.added), normalize(added), "added");
  assert.deepEqual(normalize(actual.removed), normalize(removed), "removed");
}

function assertAlerts(tracker: AlertTracker, stream: StreamKey, expected: AlertInterval[]) {
  assert.deepEqual(normalize(tracker.listAlerts(stream)), normalize(expected));
}

test("乱序形成 1..13 失败区间，校正拆分，旧版/重复忽略，再恢复", () => {
  const tracker = new AlertTracker();

  // 乱序投递 seq 1..13 全部 Failed (revision 1)
  const order = [7, 3, 11, 1, 13, 5, 9, 2, 12, 4, 10, 6, 8];
  const expectedDiffs: AlertDiff[] = [
    { added: [], removed: [] }, // 7
    { added: [], removed: [] }, // 3
    { added: [], removed: [] }, // 11
    { added: [], removed: [] }, // 1
    { added: [], removed: [] }, // 13
    { added: [], removed: [] }, // 5
    { added: [], removed: [] }, // 9
    { added: [], removed: [] }, // 2 -> {1,2,3}
    { added: [], removed: [] }, // 12 -> {11,12,13}
    { added: [], removed: [] }, // 4 -> {1..5} 长度5，未达阈值
    { added: [], removed: [] }, // 10 -> {9..13} 长度5
    { added: [iv(1, 7)], removed: [] }, // 6 -> {1..7} 首次告警
    { added: [iv(1, 13)], removed: [iv(1, 7)] }, // 8 -> {1..13} 端点扩展
  ];
  order.forEach((seq, i) => {
    const diff = tracker.apply(report(S1, seq, 1, "Failed"));
    assertDiff(diff, expectedDiffs[i]!.added, expectedDiffs[i]!.removed);
  });
  assertAlerts(tracker, S1, [iv(1, 13)]);

  // 把 7 校正为成功 (revision 2)：拆成两个长度 6 的告警
  let diff = tracker.apply(report(S1, 7, 2, "Installed"));
  assertDiff(diff, [iv(1, 6), iv(8, 13)], [iv(1, 13)]);
  assertAlerts(tracker, S1, [iv(1, 6), iv(8, 13)]);

  // 旧版本（revision 1 < 2）：忽略，空差分
  diff = tracker.apply(report(S1, 7, 1, "Failed"));
  assertDiff(diff, [], []);
  assertAlerts(tracker, S1, [iv(1, 6), iv(8, 13)]);

  // 重复版本（revision 2，内容一致）：空差分
  diff = tracker.apply(report(S1, 7, 2, "Installed"));
  assertDiff(diff, [], []);
  assertAlerts(tracker, S1, [iv(1, 6), iv(8, 13)]);

  // 重复投递其他已生效上报：空差分
  diff = tracker.apply(report(S1, 3, 1, "Failed"));
  assertDiff(diff, [], []);

  // 只提高 revision、不改变有效状态：空差分
  diff = tracker.apply(report(S1, 3, 9, "Failed"));
  assertDiff(diff, [], []);
  assertAlerts(tracker, S1, [iv(1, 6), iv(8, 13)]);

  // 用更高版本把 7 恢复为失败 (revision 3)：合并回 [1,13]
  diff = tracker.apply(report(S1, 7, 3, "Failed"));
  assertDiff(diff, [iv(1, 13)], [iv(1, 6), iv(8, 13)]);
  assertAlerts(tracker, S1, [iv(1, 13)]);
});

test("缺失序号不能跨缺口合并", () => {
  const tracker = new AlertTracker();

  // dev-2：1..6 与 8..13 失败，7 未知 -> 两个独立告警，不合并
  for (const seq of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) {
    tracker.apply(report(S2, seq, 1, "Failed"));
  }
  assertAlerts(tracker, S2, [iv(1, 6), iv(8, 13)]);

  // dev-3：1..3 与 5..9 失败，4 未知 -> 合计 8 次失败但无告警
  for (const seq of [1, 2, 3, 5, 6, 7, 8, 9]) {
    const diff = tracker.apply(report(S3, seq, 1, "Failed"));
    assertDiff(diff, [], []);
  }
  assertAlerts(tracker, S3, []);

  // 流之间互不影响
  assertAlerts(tracker, S1, []);
});

test("成功截断区间；不足 6 不告警；多区间并存", () => {
  const tracker = new AlertTracker();
  const s: StreamKey = { deviceId: "d", applicationId: "a" };

  // 1..5 失败：长度 5，无告警
  for (let seq = 1; seq <= 5; seq++) {
    assertDiff(tracker.apply(report(s, seq, 1, "Failed")), [], []);
  }
  assertAlerts(tracker, s, []);

  // 6 成功：仍然无告警；7..13 失败：新增 [7,13]
  assertDiff(tracker.apply(report(s, 6, 1, "Installed")), [], []);
  let diff: AlertDiff = { added: [], removed: [] };
  for (let seq = 7; seq <= 13; seq++) {
    diff = tracker.apply(report(s, seq, 1, "Failed"));
  }
  assertDiff(diff, [iv(7, 13)], [iv(7, 12)]);

  // 20..25 失败：第二个互不相连的区间，与第一个并存
  for (let seq = 20; seq <= 25; seq++) {
    diff = tracker.apply(report(s, seq, 1, "Failed"));
  }
  assertDiff(diff, [iv(20, 25)], []);
  assertAlerts(tracker, s, [iv(7, 13), iv(20, 25)]);

  // 把 10 校正为成功：[7,13] 被截断成两段不足 6 的残段，整体消失
  diff = tracker.apply(report(s, 10, 2, "Installed"));
  assertDiff(diff, [], [iv(7, 13)]);
  assertAlerts(tracker, s, [iv(20, 25)]);

  // 任意久远作业也可校正：把 22 改为成功，[20,25] 消失
  diff = tracker.apply(report(s, 22, 2, "Installed"));
  assertDiff(diff, [], [iv(20, 25)]);
  assertAlerts(tracker, s, []);
});
