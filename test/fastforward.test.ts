import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, type FiredRule, type Project } from '../src/index.js';

/**
 * 场景：A --100ms--> B --100ms--> C --100ms--> A 循环，
 * 每次跳转 count +1；C 上按 count 分支：count < 5 时额外 +10 并把 flag 置真。
 */
const project: Project = {
  initialScreen: 'A',
  variables: [
    { name: 'count', type: 'number', initial: 0 },
    { name: 'flag', type: 'boolean', initial: false },
  ],
  screens: [
    {
      name: 'A',
      rules: [
        {
          trigger: { kind: 'timer', delayMs: 100 },
          branches: [
            { conditions: [], actions: [
              { kind: 'adjust', variable: 'count', delta: 1 },
              { kind: 'navigate', screen: 'B' },
            ] },
          ],
        },
      ],
    },
    {
      name: 'B',
      rules: [
        {
          trigger: { kind: 'timer', delayMs: 100 },
          branches: [
            { conditions: [], actions: [
              { kind: 'adjust', variable: 'count', delta: 1 },
              { kind: 'navigate', screen: 'C' },
            ] },
          ],
        },
      ],
    },
    {
      name: 'C',
      rules: [
        {
          trigger: { kind: 'timer', delayMs: 100 },
          branches: [
            {
              conditions: [{ variable: 'count', op: 'lt', value: 5 }],
              actions: [
                { kind: 'adjust', variable: 'count', delta: 11 },
                { kind: 'set', variable: 'flag', value: true },
                { kind: 'navigate', screen: 'A' },
              ],
            },
            {
              conditions: [],
              actions: [
                { kind: 'adjust', variable: 'count', delta: 1 },
                { kind: 'navigate', screen: 'A' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** 独立参考实现：按场景结构逐时刻推导，不经过被测引擎 */
function reference(totalMs: number): { fired: FiredRule[]; count: number; flag: boolean; screen: string } {
  const fired: FiredRule[] = [];
  let count = 0;
  let flag = false;
  let screen = 'A';
  let enteredAt = 0;
  const ruleIndexOf: Record<string, number> = { A: 0, B: 0, C: 0 };
  for (;;) {
    const due = enteredAt + 100;
    if (due > totalMs) break;
    const from = screen;
    count += 1;
    let branchIndex = 1;
    if (from === 'C' && count - 1 < 5) {
      count += 10;
      flag = true;
      branchIndex = 0;
    }
    screen = from === 'A' ? 'B' : from === 'B' ? 'C' : 'A';
    enteredAt = due;
    fired.push({ at: due, screen: from, ruleIndex: ruleIndexOf[from] as number, triggerKind: 'timer', branchIndex: from === 'C' ? branchIndex : 0 });
  }
  return { fired, count, flag, screen };
}

test('快进跨越连续延时跳转与变量变更，与逐时刻参考结果一致', () => {
  const total = 100_000;
  const expected = reference(total);

  const session = createSession(project, 0);
  const result = session.advanceTo(total);

  assert.deepEqual(result.fired, expected.fired);
  const state = session.getState();
  assert.equal(state.screen, expected.screen);
  assert.equal(state.variables.count, expected.count);
  assert.equal(state.variables.flag, expected.flag);
  assert.equal(state.expired, false);
});

test('一次性快进与分多小步推进结果完全一致', () => {
  const total = 50_000;

  const oneShot = createSession(project, 0);
  const firedOneShot = oneShot.advanceTo(total).fired;

  const stepped = createSession(project, 0);
  const firedStepped: FiredRule[] = [];
  // 用不规则步长推进，覆盖计时点落在步长内部与边界两种情况
  let t = 0;
  const steps = [37, 63, 100, 1, 250, 999, 7, 3000];
  let i = 0;
  while (t < total) {
    t = Math.min(total, t + steps[i % steps.length]!);
    i += 1;
    firedStepped.push(...stepped.advanceTo(t).fired);
  }

  assert.deepEqual(firedStepped, firedOneShot);
  assert.deepEqual(stepped.getState(), oneShot.getState());
});

test('性能：30 分钟快进含 10000 次计时触发，2 秒内完成', () => {
  // 单屏自跳转，每 100ms 一次，180000ms 内共 1800 次……改为 100ms 间隔 10000 次 = 1_000_000ms < 30min
  const perfProject: Project = {
    initialScreen: 'S',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'S',
        rules: [
          {
            trigger: { kind: 'timer', delayMs: 100 },
            branches: [
              { conditions: [], actions: [
                { kind: 'adjust', variable: 'n', delta: 1 },
                { kind: 'navigate', screen: 'S' },
              ] },
            ],
          },
        ],
      },
    ],
  };
  const session = createSession(perfProject, 0);
  const start = performance.now();
  const result = session.advanceTo(1_000_000);
  const elapsed = performance.now() - start;
  assert.equal(result.fired.length, 10_000);
  assert.equal(session.getState().variables.n, 10_000);
  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
});
