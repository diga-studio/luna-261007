import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackEngine, ProjectDefinition, TriggerRecord } from "../src/index";

const MIN = 60 * 1000;

/**
 * 跨屏幕计时链 + 变量分支 + 返回的项目：
 * A --150ms--> B（n+=1），B --250ms--> 返回 A（n+=2），n>=30 后停在 A 并改 mode。
 */
function chainProject(): ProjectDefinition {
  return {
    initialScreen: "A",
    variables: [
      { name: "n", type: "number", initial: 0 },
      { name: "mode", type: "string", initial: "run" },
    ],
    screens: [
      {
        name: "A",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 150 },
            branches: [
              {
                conditions: [{ variable: "n", op: "lt", value: 30 }],
                actions: [
                  { kind: "add", variable: "n", delta: 1 },
                  { kind: "navigate", screen: "B" },
                ],
              },
              {
                conditions: [],
                actions: [{ kind: "set", variable: "mode", value: "done" }],
              },
            ],
          },
        ],
      },
      {
        name: "B",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 250 },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 2 },
                  { kind: "back" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** 用指定步长推进，收集全部触发记录 */
function runChunked(project: ProjectDefinition, stepMs: number, totalMs: number) {
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const all: TriggerRecord[] = [];
  for (let t = stepMs; t <= totalMs; t += stepMs) {
    all.push(...engine.advanceTo(s, t).triggers);
  }
  return { triggers: all, state: engine.getState(s) };
}

test("快进与逐时刻推进得到完全一致的触发顺序、逻辑时间与最终状态", () => {
  const total = 60 * 1000;
  const oneShot = runChunked(chainProject(), total, total);
  const fine = runChunked(chainProject(), 37, total); // 步长与延时不互质
  const coarse = runChunked(chainProject(), 1000, total);

  assert.equal(oneShot.triggers.length, 21, "10 轮往返 + 最终一次分支触发");
  assert.deepEqual(fine.triggers, oneShot.triggers);
  assert.deepEqual(coarse.triggers, oneShot.triggers);
  assert.deepEqual(fine.state, oneShot.state);
  assert.deepEqual(coarse.state, oneShot.state);

  // 触发记录按逻辑时间非递减
  for (let i = 1; i < oneShot.triggers.length; i++) {
    assert.ok(oneShot.triggers[i]!.time >= oneShot.triggers[i - 1]!.time);
  }
  // 最终状态符合手算：每轮 A->B->A 使 n+=3，n 到 30 后 A 的计时走第二分支
  assert.equal(oneShot.state.currentScreen, "A");
  assert.equal(oneShot.state.variables["mode"], "done");
  assert.equal(oneShot.state.variables["n"], 30);
});

test("快进中穿插点按，与逐步推进结果一致", () => {
  const project = chainProject();
  project.screens[0]!.rules.push({
    trigger: { kind: "tap", name: "boost" },
    branches: [
      { conditions: [], actions: [{ kind: "add", variable: "n", delta: 5 }] },
    ],
  });

  const engine1 = new PlaybackEngine(project);
  const s1 = engine1.createSession(0);
  const oneShot = [
    ...engine1.tap(s1, "boost", 400).triggers,
    ...engine1.advanceTo(s1, 60000).triggers,
  ];
  const state1 = engine1.getState(s1);

  const engine2 = new PlaybackEngine(project);
  const s2 = engine2.createSession(0);
  const stepped: TriggerRecord[] = [];
  for (let t = 100; t <= 400; t += 100) stepped.push(...engine2.advanceTo(s2, t).triggers);
  stepped.push(...engine2.tap(s2, "boost", 400).triggers);
  for (let t = 500; t <= 60000; t += 113) stepped.push(...engine2.advanceTo(s2, t).triggers);
  const state2 = engine2.getState(s2);

  assert.deepEqual(stepped, oneShot);
  assert.deepEqual(state2, state1);
});

test("性能：30 分钟快进含上万次计时触发，2 秒内完成", () => {
  const project: ProjectDefinition = {
    initialScreen: "loop",
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "loop",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 100 },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 1 },
                  { kind: "navigate", screen: "loop" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const start = Date.now();
  const r = engine.advanceTo(s, 30 * MIN);
  const elapsed = Date.now() - start;
  assert.ok(r.triggers.length >= 10000, `触发次数 ${r.triggers.length} 应 >= 10000`);
  assert.ok(elapsed < 2000, `耗时 ${elapsed}ms 应 < 2000ms`);
});
