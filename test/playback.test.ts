import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackEngine, ProjectDefinition } from "../src/index";
import { makeProject } from "./helpers";

test("会话从初始屏幕与初始变量开始，各会话互不影响", () => {
  const project = makeProject({
    variables: [
      { name: "count", type: "number", initial: 0 },
      { name: "label", type: "string", initial: "a" },
      { name: "flag", type: "boolean", initial: false },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s1 = engine.createSession(1000);
  const s2 = engine.createSession(5000);

  engine.tap(s1, "noop", 2000);
  const v1 = engine.getState(s1);
  const v2 = engine.getState(s2);
  assert.equal(v1.currentScreen, "home");
  assert.deepEqual(v1.variables, { count: 0, label: "a", flag: false });
  assert.deepEqual(v2.variables, { count: 0, label: "a", flag: false });
  assert.equal(v1.expired, false);
});

test("点按规则按有序分支选择首个满足的分支并顺序执行动作", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 5 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "go" },
            branches: [
              {
                conditions: [{ variable: "n", op: "gt", value: 10 }],
                actions: [{ kind: "set", variable: "n", value: 100 }],
              },
              {
                conditions: [
                  { variable: "n", op: "gte", value: 5 },
                  { variable: "n", op: "lt", value: 10 },
                ],
                actions: [
                  { kind: "add", variable: "n", delta: 3 },
                  { kind: "navigate", screen: "next" },
                ],
              },
              { conditions: [], actions: [{ kind: "set", variable: "n", value: -1 }] },
            ],
          },
        ],
      },
      { name: "next", rules: [] },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.tap(s, "go", 1000);
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0]!.branchIndex, 1);
  assert.equal(r.triggers[0]!.time, 1000);
  assert.equal(r.triggers[0]!.screen, "home");
  const st = engine.getState(s);
  assert.equal(st.currentScreen, "next");
  assert.equal(st.variables["n"], 8);
  assert.deepEqual(st.history, ["home"]);
});

test("无分支满足时无动作、无记录", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "go" },
            branches: [
              {
                conditions: [{ variable: "n", op: "eq", value: 1 }],
                actions: [{ kind: "navigate", screen: "next" }],
              },
            ],
          },
        ],
      },
      { name: "next", rules: [] },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.tap(s, "go", 100);
  assert.equal(r.triggers.length, 0);
  assert.equal(engine.getState(s).currentScreen, "home");
});

test("未匹配的点按无动作，但仍刷新活动时间", () => {
  const project = makeProject();
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.tap(s, "unknown", 29 * 60 * 1000);
  assert.equal(r.triggers.length, 0);
  // 29 分钟时的点按刷新了活动时间，30 分钟整点未过期
  engine.advanceTo(s, 30 * 60 * 1000);
  assert.equal(engine.getState(s).expired, false);
  // 新的到期时刻为 29+30=59 分钟整
  engine.advanceTo(s, 59 * 60 * 1000 - 1);
  assert.equal(engine.getState(s).expired, false);
  engine.advanceTo(s, 59 * 60 * 1000);
  assert.equal(engine.getState(s).expired, true);
});

test("导航压入历史，返回取出最近一项且不恢复变量", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "a",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
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
        ],
      },
      {
        name: "b",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 10 },
                  { kind: "navigate", screen: "c" },
                ],
              },
            ],
          },
          {
            trigger: { kind: "tap", name: "back" },
            branches: [{ conditions: [], actions: [{ kind: "back" }] }],
          },
        ],
      },
      { name: "c", rules: [] },
    ],
    initialScreen: "a",
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  engine.tap(s, "t", 1);
  engine.tap(s, "t", 2);
  let st = engine.getState(s);
  assert.equal(st.currentScreen, "c");
  assert.deepEqual(st.history, ["a", "b"]);
  assert.equal(st.variables["n"], 11);
  // c 上没有 back 规则，改用直接构造：在 c 加 back 规则会更直观，这里用 b 的 back 验证
  // 从 c 无法返回（无规则），改测 b 的 back：
  const engine2 = new PlaybackEngine(project);
  const s2 = engine2.createSession(0);
  engine2.tap(s2, "t", 1); // a -> b, n=1
  engine2.tap(s2, "back", 2); // b -> a, 不压历史
  st = engine2.getState(s2);
  assert.equal(st.currentScreen, "a");
  assert.deepEqual(st.history, []);
  assert.equal(st.variables["n"], 1);
});

test("空历史时返回无动作", () => {
  const project = makeProject({
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "back" },
            branches: [{ conditions: [], actions: [{ kind: "back" }] }],
          },
        ],
      },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  const r = engine.tap(s, "back", 10);
  assert.equal(r.triggers.length, 1); // 分支被选中并执行，back 本身无动作
  assert.equal(engine.getState(s).currentScreen, "home");
  assert.deepEqual(engine.getState(s).history, []);
});

test("返回历史最多 20 项，满时丢弃最早一项", () => {
  const screens = [];
  for (let i = 0; i <= 25; i++) {
    screens.push({
      name: `s${i}`,
      rules:
        i < 25
          ? [
              {
                trigger: { kind: "tap", name: "next" },
                branches: [
                  { conditions: [], actions: [{ kind: "navigate", screen: `s${i + 1}` }] },
                ],
              },
            ]
          : [],
    });
  }
  const project = makeProject({ initialScreen: "s0", screens: screens as never });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  for (let i = 1; i <= 25; i++) engine.tap(s, "next", i);
  const st = engine.getState(s);
  assert.equal(st.history.length, 20);
  assert.equal(st.history[0], "s5"); // s0..s4 中最早的已被丢弃
  assert.equal(st.history[19], "s24");
});

test("字符串与布尔相等比较", () => {
  const project = makeProject({
    variables: [
      { name: "s", type: "string", initial: "x" },
      { name: "b", type: "boolean", initial: true },
    ],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              {
                conditions: [
                  { variable: "s", op: "eq", value: "x" },
                  { variable: "b", op: "neq", value: false },
                ],
                actions: [{ kind: "set", variable: "s", value: "hit" }],
              },
            ],
          },
        ],
      },
    ],
  });
  const engine = new PlaybackEngine(project);
  const sess = engine.createSession(0);
  engine.tap(sess, "t", 1);
  assert.equal(engine.getState(sess).variables["s"], "hit");
});

test("时间戳不递减时抛错", () => {
  const engine = new PlaybackEngine(makeProject());
  const s = engine.createSession(100);
  assert.throws(() => engine.tap(s, "x", 99));
  engine.tap(s, "x", 100);
  assert.throws(() => engine.advanceTo(s, 50));
});
