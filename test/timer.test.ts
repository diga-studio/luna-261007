import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackEngine } from "../src/index";
import { makeProject } from "./helpers";

test("计时到点触发，逻辑时间为到点时刻而非推进终点", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 500 },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "n", delta: 1 }] },
            ],
          },
        ],
      },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  // 未到点
  let r = engine.advanceTo(s, 499);
  assert.equal(r.triggers.length, 0);
  assert.equal(engine.getState(s).variables["n"], 0);
  // 一次推进越过到点时刻
  r = engine.advanceTo(s, 5000);
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0]!.time, 500);
  assert.equal(engine.getState(s).variables["n"], 1);
  // 本轮进入中最多触发一次：再次推进不重复触发
  r = engine.advanceTo(s, 60000);
  assert.equal(r.triggers.length, 0);
  assert.equal(engine.getState(s).variables["n"], 1);
});

test("计时无分支满足也不重试", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 100 },
            branches: [
              {
                conditions: [{ variable: "n", op: "eq", value: 999 }],
                actions: [{ kind: "set", variable: "n", value: 1 }],
              },
            ],
          },
        ],
      },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.advanceTo(s, 10000);
  assert.equal(r.triggers.length, 0);
  assert.equal(engine.getState(s).variables["n"], 0);
});

test("离开屏幕后未触发的计时失效，再次进入重新计时", () => {
  const project = makeProject({
    screens: [
      {
        name: "a",
        rules: [
          {
            trigger: { kind: "tap", name: "go" },
            branches: [{ conditions: [], actions: [{ kind: "navigate", screen: "b" }] }],
          },
          {
            trigger: { kind: "timer", delayMs: 1000 },
            branches: [{ conditions: [], actions: [{ kind: "navigate", screen: "c" }] }],
          },
        ],
      },
      {
        name: "b",
        rules: [
          {
            trigger: { kind: "tap", name: "go" },
            branches: [{ conditions: [], actions: [{ kind: "navigate", screen: "a" }] }],
          },
        ],
      },
      { name: "c", rules: [] },
    ],
    initialScreen: "a",
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  engine.tap(s, "go", 500); // 离开 a，a 的计时失效
  engine.tap(s, "go", 1200); // 重新进入 a，从 1200 重新计时
  let r = engine.advanceTo(s, 2199);
  assert.equal(r.triggers.length, 0);
  r = engine.advanceTo(s, 2200);
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0]!.time, 2200);
  assert.equal(engine.getState(s).currentScreen, "c");
});

test("导航到当前屏幕按重新进入处理，不沿用原计时", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "reset" },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 1 },
                  { kind: "navigate", screen: "home" },
                ],
              },
            ],
          },
          {
            trigger: { kind: "timer", delayMs: 1000 },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "n", delta: 100 }] },
            ],
          },
        ],
      },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  engine.tap(s, "reset", 900); // 重新进入，计时从 900 起算
  const r = engine.advanceTo(s, 1899);
  assert.equal(r.triggers.length, 0);
  const r2 = engine.advanceTo(s, 1900);
  assert.equal(r2.triggers.length, 1);
  assert.equal(r2.triggers[0]!.time, 1900);
  assert.equal(engine.getState(s).variables["n"], 101);
  // 自导航也压入历史
  assert.deepEqual(engine.getState(s).history, ["home"]);
});

test("同刻计时按配置顺序处理，前一条离开后其余不再触发", () => {
  const project = makeProject({
    variables: [{ name: "log", type: "number", initial: 0 }],
    screens: [
      {
        name: "a",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 1000 },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "log", delta: 1 },
                  { kind: "navigate", screen: "b" },
                ],
              },
            ],
          },
          {
            trigger: { kind: "timer", delayMs: 1000 },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "log", delta: 10 }] },
            ],
          },
        ],
      },
      { name: "b", rules: [] },
    ],
    initialScreen: "a",
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.advanceTo(s, 5000);
  // 第一条触发并离开，第二条同刻计时不再触发
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0]!.time, 1000);
  assert.equal(engine.getState(s).currentScreen, "b");
  assert.equal(engine.getState(s).variables["log"], 1);
});

test("同刻计时先导航，随后返回：旧计时不触发，新计时从重新进入时刻计算", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "a",
        rules: [
          {
            // 配置在前：1000ms 时先导航到 b（仅首轮满足条件）
            trigger: { kind: "timer", delayMs: 1000 },
            branches: [
              {
                conditions: [{ variable: "n", op: "eq", value: 0 }],
                actions: [
                  { kind: "set", variable: "n", value: 1 },
                  { kind: "navigate", screen: "b" },
                ],
              },
            ],
          },
          {
            // 同刻的第二条：首轮因离开而不触发
            trigger: { kind: "timer", delayMs: 1000 },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "n", delta: 1000 }] },
            ],
          },
        ],
      },
      {
        name: "b",
        rules: [
          {
            // 500ms 后返回 a
            trigger: { kind: "timer", delayMs: 500 },
            branches: [{ conditions: [], actions: [{ kind: "back" }] }],
          },
        ],
      },
    ],
    initialScreen: "a",
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.advanceTo(s, 10000);
  // t=1000: a->b（n=1），a 的第二条同刻计时失效；
  // t=1500: b 返回 a（1500 重新进入，计时重算）；
  // t=2500: 第一条条件不再满足（无记录），第二条触发 n+=1000
  assert.deepEqual(
    r.triggers.map((t) => [t.time, t.screen]),
    [
      [1000, "a"],
      [1500, "b"],
      [2500, "a"],
    ],
  );
  const st = engine.getState(s);
  assert.equal(st.currentScreen, "a");
  assert.equal(st.variables["n"], 1001); // 第二条只触发过一次
  assert.deepEqual(st.history, []); // 压入 a 后又弹出
});

test("连续延时跳转与变量变更：新计时从实际进入时刻计算", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "s1",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 200 },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 1 },
                  { kind: "navigate", screen: "s2" },
                ],
              },
            ],
          },
        ],
      },
      {
        name: "s2",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 300 },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 10 },
                  { kind: "navigate", screen: "s3" },
                ],
              },
            ],
          },
        ],
      },
      {
        name: "s3",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 100 },
            branches: [
              {
                conditions: [{ variable: "n", op: "eq", value: 11 }],
                actions: [{ kind: "set", variable: "n", value: 1100 }],
              },
            ],
          },
        ],
      },
    ],
    initialScreen: "s1",
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.advanceTo(s, 60000);
  assert.deepEqual(
    r.triggers.map((t) => t.time),
    [200, 500, 600],
  );
  assert.equal(engine.getState(s).variables["n"], 1100);
  assert.equal(engine.getState(s).currentScreen, "s3");
});

test("点按先处理同刻计时，再匹配点按规则", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "a",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 1000 },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 1 },
                  { kind: "navigate", screen: "b" },
                ],
              },
            ],
          },
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "n", delta: 100 }] },
            ],
          },
        ],
      },
      {
        name: "b",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "n", delta: 7 }] },
            ],
          },
        ],
      },
    ],
    initialScreen: "a",
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  // t=1000 的点按：先触发 a 的计时（导航到 b），点按落在 b 的规则上
  const r = engine.tap(s, "t", 1000);
  assert.deepEqual(
    r.triggers.map((x) => [x.time, x.screen, x.trigger.kind]),
    [
      [1000, "a", "timer"],
      [1000, "b", "tap"],
    ],
  );
  assert.equal(engine.getState(s).variables["n"], 8);
  assert.equal(engine.getState(s).currentScreen, "b");
});

test("同一时间戳的多次点按按调用顺序处理", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "inc" },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "n", delta: 1 }] },
            ],
          },
        ],
      },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  engine.tap(s, "inc", 500);
  engine.tap(s, "inc", 500);
  engine.tap(s, "inc", 500);
  assert.equal(engine.getState(s).variables["n"], 3);
});
