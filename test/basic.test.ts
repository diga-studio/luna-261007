import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, validateProject, type Project } from '../src/index.js';

test('点按先处理同刻到点计时，再匹配当时当前屏幕上的规则', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'timer', delayMs: 100 },
            branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'B' }] }],
          },
          {
            trigger: { kind: 'tap', name: 'go' },
            branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'C' }] }],
          },
        ],
      },
      {
        name: 'B',
        rules: [
          {
            trigger: { kind: 'tap', name: 'go' },
            branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'D' }] }],
          },
        ],
      },
      { name: 'C', rules: [] },
      { name: 'D', rules: [] },
    ],
  };
  const session = createSession(project, 0);
  // 点按时间戳 100：100ms 计时先触发（A->B），点按匹配到 B 的规则（B->D）
  const result = session.tap(100, 'go');
  assert.deepEqual(
    result.fired.map((f) => [f.at, f.screen, f.triggerKind]),
    [
      [100, 'A', 'timer'],
      [100, 'B', 'tap'],
    ],
  );
  assert.equal(session.getState().screen, 'D');
});

test('同一时间戳的多次点按按调用顺序处理；未匹配点按无动作', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'tap', name: 'inc' },
            branches: [{ conditions: [], actions: [{ kind: 'adjust', variable: 'n', delta: 1 }] }],
          },
        ],
      },
    ],
  };
  const session = createSession(project, 0);
  session.tap(50, 'inc');
  session.tap(50, 'miss'); // 未匹配：无动作
  const result = session.tap(50, 'inc');
  assert.equal(result.fired.length, 1);
  assert.equal(session.getState().variables.n, 2);
});

test('分支按当时变量选择首个满足项，执行期间不重新选择', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'tap', name: 'go' },
            branches: [
              // 第一分支：n==0 时命中；动作把 n 改成 5，但不得因此改选后续分支
              {
                conditions: [{ variable: 'n', op: 'eq', value: 0 }],
                actions: [{ kind: 'set', variable: 'n', value: 5 }],
              },
              {
                conditions: [{ variable: 'n', op: 'gte', value: 5 }],
                actions: [{ kind: 'set', variable: 'n', value: 99 }],
              },
            ],
          },
        ],
      },
    ],
  };
  const session = createSession(project, 0);
  const first = session.tap(0, 'go');
  assert.equal(first.fired[0]!.branchIndex, 0);
  assert.equal(session.getState().variables.n, 5); // 不是 99

  const second = session.tap(1, 'go');
  assert.equal(second.fired[0]!.branchIndex, 1);
  assert.equal(session.getState().variables.n, 99);
});

test('各会话互不影响', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'tap', name: 'inc' },
            branches: [{ conditions: [], actions: [{ kind: 'adjust', variable: 'n', delta: 1 }] }],
          },
        ],
      },
    ],
  };
  const s1 = createSession(project, 0);
  const s2 = createSession(project, 0);
  s1.tap(0, 'inc');
  s1.tap(1, 'inc');
  s2.tap(0, 'inc');
  assert.equal(s1.getState().variables.n, 2);
  assert.equal(s2.getState().variables.n, 1);
  // 项目定义不被会话修改
  assert.equal(project.variables[0]!.initial, 0);
});

test('时间戳必须不递减', () => {
  const project: Project = { initialScreen: 'A', variables: [], screens: [{ name: 'A', rules: [] }] };
  const session = createSession(project, 100);
  session.advanceTo(200);
  assert.throws(() => session.tap(199, 'x'), /non-decreasing/);
  assert.throws(() => session.advanceTo(150), /non-decreasing/);
  assert.throws(() => session.getState(50), /non-decreasing/);
});

test('validateProject 拒绝非法定义', () => {
  const base: Project = {
    initialScreen: 'A',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [{ name: 'A', rules: [] }],
  };
  assert.doesNotThrow(() => validateProject(base));

  const bad = (mutate: (p: Project) => void): void => {
    const project = structuredClone(base);
    mutate(project);
    assert.throws(() => validateProject(project));
  };

  bad((p) => { p.initialScreen = 'nope'; });
  bad((p) => { p.screens.push({ name: 'A', rules: [] }); });
  bad((p) => { p.variables.push({ name: 'n', type: 'number', initial: 1 }); });
  bad((p) => { p.variables.push({ name: 's', type: 'string', initial: 1 as unknown as string }); });
  bad((p) => { p.screens[0]!.rules.push({ trigger: { kind: 'timer', delayMs: 99 }, branches: [] }); });
  bad((p) => { p.screens[0]!.rules.push({ trigger: { kind: 'timer', delayMs: 10_001 }, branches: [] }); });
  bad((p) => {
    p.screens[0]!.rules.push({
      trigger: { kind: 'tap', name: 'x' },
      branches: [{ conditions: [{ variable: 'ghost', op: 'eq', value: 1 }], actions: [] }],
    });
  });
  bad((p) => {
    p.screens[0]!.rules.push({
      trigger: { kind: 'tap', name: 'x' },
      branches: [{ conditions: [], actions: [{ kind: 'adjust', variable: 'n', delta: 1 }, { kind: 'back' }, { kind: 'set', variable: 'n', value: 0 }] }],
    });
  });
  bad((p) => {
    p.screens[0]!.rules.push({
      trigger: { kind: 'tap', name: 'x' },
      branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'ghost' }] }],
    });
  });
});

test('条件支持字符串/布尔相等与数字大小比较', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [
      { name: 's', type: 'string', initial: 'hello' },
      { name: 'b', type: 'boolean', initial: true },
      { name: 'n', type: 'number', initial: 3 },
    ],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'tap', name: 'go' },
            branches: [
              {
                conditions: [
                  { variable: 's', op: 'eq', value: 'hello' },
                  { variable: 'b', op: 'eq', value: true },
                  { variable: 'n', op: 'gt', value: 2 },
                  { variable: 'n', op: 'lte', value: 3 },
                ],
                actions: [{ kind: 'navigate', screen: 'B' }],
              },
            ],
          },
        ],
      },
      { name: 'B', rules: [] },
    ],
  };
  const session = createSession(project, 0);
  session.tap(0, 'go');
  assert.equal(session.getState().screen, 'B');
});
