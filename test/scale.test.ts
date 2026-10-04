import test from "node:test";
import assert from "node:assert/strict";
import { WaitlistEngine } from "../src/index.ts";

/** 可复现的伪随机数发生器（mulberry32）。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 规模测试：10 万条候补，绝大多数因成员被占用而不可录取。
 * 之后反复进行只影响少量成员的撤回与新增，
 * 用引擎的诊断计数证明这些无关候补没有被反复扫描。
 */
test("10 万候补下局部撤回/新增的工作量与受影响候补数成正比", () => {
  const rng = makeRng(12345);
  const BLOCKED_COUNT = 100_000;
  const BLOCKER_TEAMS = 100; // 100 支已录取团队，每队 20 人，共 2000 个“占位成员”
  const TEAM_SIZE = 20;

  const engine = new WaitlistEngine({ capacities: [64, BLOCKER_TEAMS * TEAM_SIZE] });

  // 占位成员录取在赛道 1（永不被撤回）。
  const blockerMembers: string[] = [];
  for (let team = 0; team < BLOCKER_TEAMS; team += 1) {
    const members: string[] = [];
    for (let i = 0; i < TEAM_SIZE; i += 1) {
      const member = `blocker-${team}-${i}`;
      members.push(member);
      blockerMembers.push(member);
    }
    engine.register(1, members);
  }

  // 10 万条候补挂在赛道 1，每条都含一个占位成员（同赛道自冲突），
  // 因此全部不可录取；其余成员唯一，不与后续活跃操作相关。
  const blockedIds: number[] = [];
  for (let i = 0; i < BLOCKED_COUNT; i += 1) {
    const blocker = blockerMembers[i % blockerMembers.length] as string;
    const size = 1 + Math.floor(rng() * (TEAM_SIZE - 1));
    const members = [blocker];
    for (let k = 1; k < size; k += 1) members.push(`filler-${i}-${k}`);
    blockedIds.push(engine.register(1, members));
  }

  const afterSetup = engine.inspect();
  assert.equal(afterSetup.registrations.length, BLOCKER_TEAMS + BLOCKED_COUNT);
  for (const id of blockedIds) {
    assert.equal(
      afterSetup.registrations[id]?.status,
      "waitlisted",
      "blocked entries must stay waitlisted",
    );
  }

  // 活跃阶段：在赛道 0 上反复进行只涉及少量新成员的撤回与新增。
  const diagBefore = { ...engine.diagnostics };
  const ACTIVE_OPS = 2_000;
  const liveOnTrack0: number[] = [];
  let memberCounter = 0;
  for (let op = 0; op < ACTIVE_OPS; op += 1) {
    if (liveOnTrack0.length > 0 && rng() < 0.5) {
      const index = Math.floor(rng() * liveOnTrack0.length);
      const id = liveOnTrack0.splice(index, 1)[0] as number;
      engine.withdraw(id);
    } else {
      const size = 1 + Math.floor(rng() * 3);
      const members: string[] = [];
      for (let k = 0; k < size; k += 1) {
        members.push(`active-${memberCounter}`);
        memberCounter += 1;
      }
      liveOnTrack0.push(engine.register(0, members));
      // 控制赛道 0 上的候补上界，保持“受影响候补”很少。
      if (liveOnTrack0.length > 40) {
        engine.withdraw(liveOnTrack0.shift() as number);
      }
    }
  }
  const diagAfter = engine.diagnostics;

  const touches =
    diagAfter.candidatesPushed -
    diagBefore.candidatesPushed +
    (diagAfter.candidatesPopped - diagBefore.candidatesPopped) +
    (diagAfter.memberBlockUpdates - diagBefore.memberBlockUpdates);

  // 每次活跃操作只涉及赛道 0 上极少数候补（上界约 40 条）；
  // 若引擎反复扫描 10 万条无关候补，touches 将高达数亿。
  const perOp = touches / ACTIVE_OPS;
  assert.ok(
    perOp < 200,
    `per-op touched waitlist entries ${perOp.toFixed(1)} should be tiny ` +
      `(total ${touches} for ${ACTIVE_OPS} ops with ${BLOCKED_COUNT} unrelated waitlisted entries)`,
  );

  // 无关候补从未被触及：赛道 1 上的候补全部保持候补状态且未被录取。
  const finalSnapshot = engine.inspect();
  for (const id of blockedIds) {
    assert.equal(finalSnapshot.registrations[id]?.status, "waitlisted");
  }
  assert.ok(
    (finalSnapshot.tracks[0]?.occupied ?? 0) <= 64,
    "track capacity never exceeded",
  );

  // 规模测试可复现性：打印一次操作的摊销触及量，便于人工核查。
  console.log(
    `scale test: ${BLOCKED_COUNT} unrelated waitlisted, ` +
      `${ACTIVE_OPS} local ops, ${touches} total touches ` +
      `(${perOp.toFixed(2)}/op)`,
  );
});

test("新增大量不可录取条目后，后续局部操作成本不增长", () => {
  // 对照：同一引擎分两段执行相同的活跃操作，第二段之前注入 5 万条无关候补，
  // 两段的诊断增量应处于同一量级。
  const runActivePhase = (engine: WaitlistEngine, ops: number, tag: string): number => {
    const rng = makeRng(777);
    const before = { ...engine.diagnostics };
    const live: number[] = [];
    let counter = 0;
    for (let op = 0; op < ops; op += 1) {
      if (live.length > 0 && rng() < 0.5) {
        engine.withdraw(live.splice(Math.floor(rng() * live.length), 1)[0] as number);
      } else {
        const id = engine.register(0, [`${tag}-${counter}`]);
        counter += 1;
        live.push(id);
        // 赛道 0 容量 4：大部分报名成为候补，控制同时存活的数量。
        if (live.length > 8) {
          engine.withdraw(live.shift() as number);
        }
      }
    }
    const after = engine.diagnostics;
    return (
      after.candidatesPushed -
      before.candidatesPushed +
      (after.candidatesPopped - before.candidatesPopped) +
      (after.memberBlockUpdates - before.memberBlockUpdates)
    );
  };

  const engine = new WaitlistEngine({ capacities: [4, 10] });
  engine.register(1, ["anchor-1", "anchor-2"]);

  const OPS = 500;
  const firstPhase = runActivePhase(engine, OPS, "early");

  for (let i = 0; i < 50_000; i += 1) {
    engine.register(1, [i % 2 === 0 ? "anchor-1" : "anchor-2", `noise-${i}`]);
  }

  const secondPhase = runActivePhase(engine, OPS, "late");

  console.log(
    `locality test: phase1 touches=${firstPhase}, phase2 touches=${secondPhase}`,
  );
  assert.ok(
    secondPhase <= firstPhase * 2 + 100,
    `second phase touches (${secondPhase}) should not grow after injecting 50k unrelated entries (first phase ${firstPhase})`,
  );
});
