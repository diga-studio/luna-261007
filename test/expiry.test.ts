import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackEngine } from "../src/index";
import { makeProject } from "./helpers";

const MIN = 60 * 1000;
const TTL = 30 * MIN;

test("连续 30 分钟无点按则过期，过期后不能恢复", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
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
  engine.advanceTo(s, TTL - 1);
  assert.equal(engine.getState(s).expired, false);
  engine.advanceTo(s, TTL);
  assert.equal(engine.getState(s).expired, true);
  // 过期后点按与推进都不再改变状态
  const r = engine.tap(s, "t", TTL + 1000);
  assert.equal(r.triggers.length, 0);
  engine.advanceTo(s, TTL + 60000);
  const st = engine.getState(s);
  assert.equal(st.expired, true);
  assert.equal(st.variables["n"], 0);
  assert.equal(st.currentScreen, "home");
});

test("到期时刻同时存在计时和点按：会话保持过期且两者均不执行", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "go" },
            branches: [{ conditions: [], actions: [{ kind: "navigate", screen: "loop" }] }],
          },
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "n", delta: 1000 }] },
            ],
          },
        ],
      },
      {
        name: "loop",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 10000 },
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
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  engine.tap(s, "go", 0); // 进入 loop；活动时间为 0，到期时刻为 TTL
  const r = engine.advanceTo(s, TTL);
  // 计时在 10000..TTL-10000 触发 179 次；第 180 次到点恰为到期时刻，到期优先不触发
  assert.equal(r.triggers.length, 179);
  assert.equal(engine.getState(s).expired, true);
  assert.equal(engine.getState(s).variables["n"], 179);
  // 同刻点按也不执行
  const r2 = engine.tap(s, "t", TTL);
  assert.equal(r2.triggers.length, 0);
  assert.equal(engine.getState(s).variables["n"], 179);
  assert.equal(engine.getState(s).currentScreen, "loop");
});

test("到期前应触发的计时仍完整执行，但不能延长会话寿命", () => {
  const project = makeProject({
    variables: [{ name: "n", type: "number", initial: 0 }],
    screens: [
      {
        name: "a",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 10000 },
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
            trigger: { kind: "timer", delayMs: 10000 },
            branches: [
              {
                conditions: [],
                actions: [
                  { kind: "add", variable: "n", delta: 10 },
                  { kind: "navigate", screen: "b" },
                ],
              },
            ],
          },
        ],
      },
    ],
    initialScreen: "a",
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  // 计时链在到期前持续触发：a@10000，b@20000..TTL-10000；TTL 整点到期
  const r = engine.advanceTo(s, TTL + 60000);
  assert.equal(r.triggers.length, 179);
  assert.equal(r.triggers[0]!.time, 10000);
  assert.equal(r.triggers[178]!.time, TTL - 10000);
  const st = engine.getState(s);
  assert.equal(st.expired, true); // 计时活动不延长寿命
  assert.equal(st.currentScreen, "b");
  assert.equal(st.variables["n"], 1 + 178 * 10);
});

test("计时、推进和查看不刷新活动时间", () => {
  const project = makeProject({
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "timer", delayMs: 100 },
            branches: [{ conditions: [], actions: [{ kind: "back" }] }],
          },
        ],
      },
    ],
  });
  const engine = new PlaybackEngine(project);
  const s = engine.createSession(0);
  engine.advanceTo(s, 100); // 计时触发
  engine.getState(s);
  engine.advanceTo(s, TTL - 1);
  engine.getState(s);
  assert.equal(engine.getState(s).expired, false);
  engine.advanceTo(s, TTL);
  assert.equal(engine.getState(s).expired, true);
});

test("过期后查看状态仍可用", () => {
  const engine = new PlaybackEngine(makeProject());
  const s = engine.createSession(0);
  engine.advanceTo(s, TTL + 1);
  const st = engine.getState(s);
  assert.equal(st.expired, true);
  assert.equal(st.currentScreen, "home");
});
