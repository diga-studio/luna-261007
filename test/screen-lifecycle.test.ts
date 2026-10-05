import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, type Project, type Screen } from '../src/index.js';

test('同刻计时按配置顺序处理，前者导航后原屏幕剩余计时不触发', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [{ name: 'x', type: 'string', initial: 'init' }],
    screens: [
      {
        name: 'A',
        rules: [
          // 配置在前：100ms 时导航到 B
          {
            trigger: { kind: 'timer', delayMs: 100 },
            branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'B' }] }],
          },
          // 配置在后：同刻，本应把 x 置为 stale，但因已离开 A 而不得触发
          {
            trigger: { kind: 'timer', delayMs: 100 },
            branches: [{ conditions: [], actions: [{ kind: 'set', variable: 'x', value: 'stale' }] }],
          },
        ],
      },
      { name: 'B', rules: [] },
    ],
  };
  const session = createSession(project, 0);
  const result = session.advanceTo(1000);
  assert.deepEqual(
    result.fired.map((f) => [f.at, f.screen, f.ruleIndex]),
    [[100, 'A', 0]],
  );
  assert.equal(session.getState().variables.x, 'init');
  assert.equal(session.getState().screen, 'B');
});

test('导航回同名屏幕后旧计时失效，新计时从重新进入时刻计算', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [
      { name: 'x', type: 'string', initial: 'init' },
      { name: 'visited', type: 'number', initial: 0 },
    ],
    screens: [
      {
        name: 'A',
        rules: [
          // 100ms：首次进入导航去 B；再次进入时条件不满足，走空分支留在 A
          {
            trigger: { kind: 'timer', delayMs: 100 },
            branches: [
              {
                conditions: [{ variable: 'visited', op: 'eq', value: 0 }],
                actions: [
                  { kind: 'set', variable: 'visited', value: 1 },
                  { kind: 'navigate', screen: 'B' },
                ],
              },
              { conditions: [], actions: [] },
            ],
          },
          // 200ms 置 stale：首次进入因 100ms 已离开而失效；再次进入从进入时刻重算
          {
            trigger: { kind: 'timer', delayMs: 200 },
            branches: [{ conditions: [], actions: [{ kind: 'set', variable: 'x', value: 'stale' }] }],
          },
        ],
      },
      {
        name: 'B',
        rules: [
          // 进入 B 后 100ms 返回 A（A 于 200ms 重新进入，stale 计时应在 400ms 到点）
          {
            trigger: { kind: 'timer', delayMs: 100 },
            branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'A' }] }],
          },
        ],
      },
    ],
  };
  const session = createSession(project, 0);
  const result = session.advanceTo(399);
  assert.deepEqual(
    result.fired.map((f) => [f.at, f.screen, f.ruleIndex, f.branchIndex]),
    [
      [100, 'A', 0, 0],
      [200, 'B', 0, 0],
      [300, 'A', 0, 1], // 再次进入后规则 0 重触发，但走空分支留在 A
    ],
  );
  assert.equal(session.getState().variables.x, 'init');

  const result2 = session.advanceTo(400);
  assert.deepEqual(
    result2.fired.map((f) => [f.at, f.screen, f.ruleIndex, f.branchIndex]),
    [[400, 'A', 1, 0]],
  );
  assert.equal(session.getState().variables.x, 'stale');
});

test('导航将当前屏幕入历史，返回取最近一项且不回填历史、不恢复变量', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'tap', name: 'go' },
            branches: [{ conditions: [], actions: [
              { kind: 'adjust', variable: 'n', delta: 1 },
              { kind: 'navigate', screen: 'B' },
            ] }],
          },
        ],
      },
      {
        name: 'B',
        rules: [
          {
            trigger: { kind: 'tap', name: 'go' },
            branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'C' }] }],
          },
          {
            trigger: { kind: 'tap', name: 'back' },
            branches: [{ conditions: [], actions: [{ kind: 'back' }] }],
          },
        ],
      },
      {
        name: 'C',
        rules: [
          {
            trigger: { kind: 'tap', name: 'back' },
            branches: [{ conditions: [], actions: [{ kind: 'back' }] }],
          },
        ],
      },
    ],
  };
  const session = createSession(project, 0);
  session.tap(0, 'go'); // A -> B, history [A]
  session.tap(1, 'go'); // B -> C, history [A, B]
  assert.deepEqual(session.getState().history, ['A', 'B']);

  session.tap(2, 'back'); // C -> B，不将 C 入历史
  let state = session.getState();
  assert.equal(state.screen, 'B');
  assert.deepEqual(state.history, ['A']);
  assert.equal(state.variables.n, 1); // 变量不恢复

  session.tap(3, 'back'); // B -> A
  state = session.getState();
  assert.equal(state.screen, 'A');
  assert.deepEqual(state.history, []);

  // 空历史返回无动作
  const result = session.tap(4, 'back');
  assert.deepEqual(result.fired, []);
  assert.equal(session.getState().screen, 'A');
});

test('返回历史最多 20 项，满时丢弃最早一项', () => {
  const screens: Screen[] = [];
  for (let i = 0; i < 25; i += 1) {
    screens.push({
      name: `S${i}`,
      rules: [
        {
          trigger: { kind: 'tap', name: 'next' },
          branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: `S${i + 1}` }] }],
        },
      ],
    });
  }
  screens.push({ name: 'S25', rules: [] });
  const project: Project = { initialScreen: 'S0', variables: [], screens };
  const session = createSession(project, 0);
  for (let i = 0; i < 25; i += 1) {
    session.tap(i, 'next');
  }
  const history = session.getState().history;
  assert.equal(history.length, 20);
  assert.deepEqual(history, ['S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14',
    'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23', 'S24']);
});

test('导航到当前屏幕按离开后重新进入处理，计时重新开始', () => {
  const project: Project = {
    initialScreen: 'S',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'S',
        rules: [
          // 150ms 自导航：每次触发都使 200ms 的计时重新开始，永远到不了点
          {
            trigger: { kind: 'timer', delayMs: 150 },
            branches: [{ conditions: [], actions: [
              { kind: 'adjust', variable: 'n', delta: 1 },
              { kind: 'navigate', screen: 'S' },
            ] }],
          },
          {
            trigger: { kind: 'timer', delayMs: 200 },
            branches: [{ conditions: [], actions: [{ kind: 'set', variable: 'n', value: -1 }] }],
          },
        ],
      },
    ],
  };
  const session = createSession(project, 0);
  const result = session.advanceTo(150 * 5);
  assert.equal(result.fired.length, 5);
  assert.deepEqual(result.fired.map((f) => f.at), [150, 300, 450, 600, 750]);
  assert.equal(session.getState().variables.n, 5); // 200ms 计时从未触发
  assert.equal(session.getState().screen, 'S');
});

test('计时规则每次进入最多触发一次，无分支满足也不重试', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'A',
        rules: [
          // 条件永不满足：触发一次后即使条件后来满足也不重试
          {
            trigger: { kind: 'timer', delayMs: 100 },
            branches: [
              {
                conditions: [{ variable: 'n', op: 'gte', value: 1 }],
                actions: [{ kind: 'set', variable: 'n', value: 99 }],
              },
            ],
          },
          {
            trigger: { kind: 'timer', delayMs: 200 },
            branches: [{ conditions: [], actions: [{ kind: 'adjust', variable: 'n', delta: 1 }] }],
          },
        ],
      },
    ],
  };
  const session = createSession(project, 0);
  const result = session.advanceTo(1000);
  assert.deepEqual(
    result.fired.map((f) => [f.at, f.ruleIndex, f.branchIndex]),
    [
      [100, 0, null], // 无分支满足，仍计为已触发
      [200, 1, 0],
    ],
  );
  assert.equal(session.getState().variables.n, 1); // 不是 99：规则 0 没有重试
});
