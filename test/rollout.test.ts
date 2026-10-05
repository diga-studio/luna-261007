import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FAILURE_COOLDOWN_MS,
  MAX_ATTEMPTS_PER_ENDPOINT,
  RECLAIM_INTERVAL_MS,
  RolloutScheduler,
} from "../src/scheduler.js";
import type { Instruction } from "../src/types.js";

function makeScheduler(): RolloutScheduler {
  return new RolloutScheduler(":memory:");
}

function ids(instructions: Instruction[]): string[] {
  return instructions.map((i) => i.attemptId);
}

test("计划：目标去重、同时只有一个活动计划、在途上限为目标数10%向下取整", () => {
  const s = makeScheduler();
  const endpoints = Array.from({ length: 25 }, (_, i) => `ep${i}`);
  const planId = s.createPlan({
    patchId: "patch-1",
    endpointIds: [...endpoints, "ep0", "ep1"],
    now: 0,
  });
  const progress = s.getProgress();
  assert.equal(progress.planId, planId);
  assert.equal(progress.totalTargets, 25);
  assert.equal(progress.inFlightCap, 2);
  assert.throws(
    () => s.createPlan({ patchId: "p2", endpointIds: ["x"], now: 1 }),
    /active plan/,
  );
  s.close();
});

test("领取：补满空闲名额、30秒内不可重复领取、重投标识与次数不变", () => {
  const s = makeScheduler();
  s.createPlan({
    patchId: "patch-1",
    endpointIds: Array.from({ length: 20 }, (_, i) => `ep${i}`),
    now: 0,
  });
  const first = s.claimInstructions(0);
  assert.equal(first.length, 2);
  assert.equal(s.getProgress().inFlight, 2);

  // 名额已满且未满 30 秒：无新指令，也不重投。
  assert.equal(s.claimInstructions(RECLAIM_INTERVAL_MS - 1).length, 0);

  // 满 30 秒：重投同一尝试，标识不变、次数不增、名额不另计。
  const reclaim = s.claimInstructions(RECLAIM_INTERVAL_MS);
  assert.deepEqual(ids(reclaim).sort(), ids(first).sort());
  assert.ok(reclaim.every((i) => i.attemptNo === 1));
  assert.equal(s.getProgress().inFlight, 2);

  // 一个尝试成功后释放名额，补进新端点。
  s.reportFeedback(first[0].attemptId, "downloading", RECLAIM_INTERVAL_MS + 1);
  s.reportFeedback(first[0].attemptId, "installing", RECLAIM_INTERVAL_MS + 2);
  s.reportFeedback(first[0].attemptId, "succeeded", RECLAIM_INTERVAL_MS + 3);
  const refill = s.claimInstructions(RECLAIM_INTERVAL_MS + 4);
  assert.equal(refill.length, 1);
  assert.equal(refill[0].attemptNo, 1);
  assert.ok(!ids(first).includes(refill[0].attemptId));
  s.close();
});

test("进度反馈：乱序与重复被忽略，不能从安装中退回下载中", () => {
  const s = makeScheduler();
  s.createPlan({ patchId: "p", endpointIds: ["ep-a"], now: 0 });
  const [instr] = s.claimInstructions(0);
  s.reportFeedback(instr.attemptId, "installing", 1);
  s.reportFeedback(instr.attemptId, "downloading", 2); // 回退，忽略
  s.reportFeedback(instr.attemptId, "installing", 3); // 重复，忽略
  const active = s.getProgress().endpoints[0].activeAttemptId;
  assert.equal(active, instr.attemptId);
  s.reportFeedback(instr.attemptId, "succeeded", 4);
  assert.equal(s.getProgress().status, "completed");
  s.close();
});

test("重复失败反馈跨越15分钟边界：冷却不推迟，到期时刻即可派发", () => {
  const s = makeScheduler();
  s.createPlan({ patchId: "p", endpointIds: ["ep-a", "ep-b"], now: 0 });
  const t0 = 1_000;
  const [first] = s.claimInstructions(t0);
  assert.equal(first.endpointId, "ep-a");

  // 首次失败被接受，冷却从该时刻起算 15 分钟。
  const failAt = t0 + 5_000;
  s.reportFeedback(first.attemptId, "failed", failAt);

  // 冷却期间 ep-a 不阻塞 ep-b 领取名额。
  const [second] = s.claimInstructions(failAt + 1);
  assert.equal(second.endpointId, "ep-b");
  s.reportFeedback(second.attemptId, "succeeded", failAt + 2);

  // 重复失败反馈落在冷却窗口内（甚至跨过 15 分钟边界投递），不得推迟冷却。
  s.reportFeedback(first.attemptId, "failed", failAt + FAILURE_COOLDOWN_MS - 1);
  s.reportFeedback(first.attemptId, "failed", failAt + FAILURE_COOLDOWN_MS + 1);

  // 到期前一毫秒不可派发。
  assert.equal(s.claimInstructions(failAt + FAILURE_COOLDOWN_MS - 1).length, 0);

  // 等于到期时刻即可派发：新尝试、次数为 2。
  const retry = s.claimInstructions(failAt + FAILURE_COOLDOWN_MS);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].endpointId, "ep-a");
  assert.equal(retry[0].attemptNo, 2);
  assert.notEqual(retry[0].attemptId, first.attemptId);
  s.reportFeedback(retry[0].attemptId, "succeeded", failAt + FAILURE_COOLDOWN_MS + 1);
  assert.equal(s.getProgress().status, "completed");
  s.close();
});

test("旧尝试反馈晚于新尝试到达：不改变新尝试状态，也不释放其名额", () => {
  const s = makeScheduler();
  s.createPlan({ patchId: "p", endpointIds: ["ep-a"], now: 0 });
  const [first] = s.claimInstructions(0);
  s.reportFeedback(first.attemptId, "failed", 1_000);

  const retryAt = 1_000 + FAILURE_COOLDOWN_MS;
  const [second] = s.claimInstructions(retryAt);
  assert.equal(second.attemptNo, 2);

  // 旧尝试的迟到反馈（含终态）一律忽略。
  s.reportFeedback(first.attemptId, "installing", retryAt + 1);
  s.reportFeedback(first.attemptId, "succeeded", retryAt + 2);

  // 新尝试仍在途，名额未被释放，不会派生出第三个尝试。
  let progress = s.getProgress();
  assert.equal(progress.inFlight, 1);
  assert.equal(progress.endpoints[0].activeAttemptId, second.attemptId);
  assert.equal(s.claimInstructions(retryAt + 3).length, 0);

  // 新尝试正常推进到终态。
  s.reportFeedback(second.attemptId, "downloading", retryAt + 4);
  s.reportFeedback(second.attemptId, "rolled_back", retryAt + 5);
  progress = s.getProgress();
  assert.equal(progress.status, "completed");
  assert.equal(progress.rolledBack, 1);
  s.close();
});

test("端到端：推进全部端点至终态，在途不超上限，每端点最多4次有效尝试", () => {
  const s = makeScheduler();
  const endpoints = Array.from({ length: 30 }, (_, i) => `ep${i}`);
  s.createPlan({ patchId: "p", endpointIds: endpoints, now: 0 });
  const cap = 3;
  let now = 0;
  const tick = () => (now += 1_000);
  const attemptsPerEndpoint = new Map<string, number>();

  // 让 ep0 一路失败到第 4 次（验证重试上限与冷却），其余全部成功。
  for (let guard = 0; guard < 10_000; guard++) {
    const progress = s.getProgress();
    assert.ok(progress.inFlight <= cap, "在途数量超过上限");
    if (progress.status === "completed") break;

    const instructions = s.claimInstructions(now);
    for (const instr of instructions) {
      const count = (attemptsPerEndpoint.get(instr.endpointId) ?? 0) + 1;
      attemptsPerEndpoint.set(instr.endpointId, count);
      assert.ok(
        count <= MAX_ATTEMPTS_PER_ENDPOINT,
        `端点 ${instr.endpointId} 超过 4 次有效尝试`,
      );
      if (instr.endpointId === "ep0") {
        s.reportFeedback(instr.attemptId, "failed", tick());
        now += FAILURE_COOLDOWN_MS; // 推进单调时钟越过冷却期
      } else {
        s.reportFeedback(instr.attemptId, "downloading", tick());
        s.reportFeedback(instr.attemptId, "installing", tick());
        s.reportFeedback(instr.attemptId, "succeeded", tick());
      }
    }
    if (instructions.length === 0) now += 1_000;
  }

  const final = s.getProgress();
  assert.equal(final.status, "completed");
  assert.equal(final.succeeded, 29);
  assert.equal(final.failed, 1);
  assert.equal(attemptsPerEndpoint.get("ep0"), MAX_ATTEMPTS_PER_ENDPOINT);
  assert.ok(final.endpoints.every((e) => e.attempts <= MAX_ATTEMPTS_PER_ENDPOINT));
  s.close();
});

test("持久化：发布状态存入 SQLite 文件，重开后进度可恢复", () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-"));
  try {
    const dbPath = join(dir, "rollout.db");
    const s1 = new RolloutScheduler(dbPath);
    const planId = s1.createPlan({
      patchId: "p",
      endpointIds: ["ep-a", "ep-b"],
      now: 0,
    });
    const [instr] = s1.claimInstructions(0);
    s1.reportFeedback(instr.attemptId, "succeeded", 1);
    s1.close();

    const s2 = new RolloutScheduler(dbPath);
    const progress = s2.getProgress();
    assert.equal(progress.planId, planId);
    assert.equal(progress.succeeded, 1);
    // 在途的 ep-b 满 30 秒后仍可重投，标识不变。
    const reclaim = s2.claimInstructions(RECLAIM_INTERVAL_MS);
    assert.equal(reclaim.length, 1);
    assert.equal(reclaim[0].endpointId, "ep-b");
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
