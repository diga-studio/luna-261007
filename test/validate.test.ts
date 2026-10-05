import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackEngine } from "../src/index";
import { makeProject } from "./helpers";

test("合法项目通过校验", () => {
  assert.doesNotThrow(() => new PlaybackEngine(makeProject()));
});

test("初始屏幕必须存在", () => {
  assert.throws(
    () => new PlaybackEngine(makeProject({ initialScreen: "ghost" })),
    /initial screen/,
  );
});

test("计时延迟必须在 100..10000 毫秒", () => {
  for (const delayMs of [99, 10001, Number.NaN]) {
    const project = makeProject({
      screens: [
        {
          name: "home",
          rules: [
            { trigger: { kind: "timer", delayMs }, branches: [] },
          ],
        },
      ],
    });
    assert.throws(() => new PlaybackEngine(project), /timer delay/);
  }
  for (const delayMs of [100, 10000]) {
    const project = makeProject({
      screens: [
        {
          name: "home",
          rules: [{ trigger: { kind: "timer", delayMs }, branches: [] }],
        },
      ],
    });
    assert.doesNotThrow(() => new PlaybackEngine(project));
  }
});

test("条件必须同类型比较，大小比较仅用于数字", () => {
  const bad1 = makeProject({
    variables: [{ name: "s", type: "string", initial: "a" }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              {
                conditions: [{ variable: "s", op: "eq", value: 1 }],
                actions: [],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.throws(() => new PlaybackEngine(bad1), /compares/);

  const bad2 = makeProject({
    variables: [{ name: "s", type: "string", initial: "a" }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              {
                conditions: [{ variable: "s", op: "gt", value: "b" }],
                actions: [],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.throws(() => new PlaybackEngine(bad2), /requires a number/);
});

test("动作引用未知变量或屏幕、类型不匹配时报错", () => {
  const unknownVar = makeProject({
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              { conditions: [], actions: [{ kind: "set", variable: "ghost", value: 1 }] },
            ],
          },
        ],
      },
    ],
  });
  assert.throws(() => new PlaybackEngine(unknownVar), /unknown variable/);

  const unknownScreen = makeProject({
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              { conditions: [], actions: [{ kind: "navigate", screen: "ghost" }] },
            ],
          },
        ],
      },
    ],
  });
  assert.throws(() => new PlaybackEngine(unknownScreen), /unknown screen/);

  const badAdd = makeProject({
    variables: [{ name: "b", type: "boolean", initial: false }],
    screens: [
      {
        name: "home",
        rules: [
          {
            trigger: { kind: "tap", name: "t" },
            branches: [
              { conditions: [], actions: [{ kind: "add", variable: "b", delta: 1 }] },
            ],
          },
        ],
      },
    ],
  });
  assert.throws(() => new PlaybackEngine(badAdd), /requires a number/);
});

test("屏幕与变量数量上限", () => {
  const screens = Array.from({ length: 201 }, (_, i) => ({ name: `s${i}`, rules: [] }));
  assert.throws(
    () => new PlaybackEngine(makeProject({ initialScreen: "s0", screens })),
    /too many screens/,
  );
  const variables = Array.from({ length: 51 }, (_, i) => ({
    name: `v${i}`,
    type: "number" as const,
    initial: 0,
  }));
  assert.throws(() => new PlaybackEngine(makeProject({ variables })), /too many variables/);

  const okScreens = Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, rules: [] }));
  assert.doesNotThrow(() => new PlaybackEngine(makeProject({ initialScreen: "s0", screens: okScreens })));
});

test("重名屏幕或变量报错", () => {
  const dupScreen = makeProject({
    screens: [
      { name: "home", rules: [] },
      { name: "home", rules: [] },
    ],
  });
  assert.throws(() => new PlaybackEngine(dupScreen), /duplicate screen/);
  const dupVar = makeProject({
    variables: [
      { name: "v", type: "number", initial: 0 },
      { name: "v", type: "number", initial: 1 },
    ],
  });
  assert.throws(() => new PlaybackEngine(dupVar), /duplicate variable/);
});

test("未知会话 id 报错", () => {
  const engine = new PlaybackEngine(makeProject());
  assert.throws(() => engine.getState("nope"), /unknown session/);
});
