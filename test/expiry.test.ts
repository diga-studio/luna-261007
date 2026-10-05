import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, SESSION_TTL_MS, type Project } from '../src/index.js';

const TTL = SESSION_TTL_MS; // 1_800_000

function timerProject(delayMs: number): Project {
  return {
    initialScreen: 'A',
    variables: [{ name: 'n', type: 'number', initial: 0 }],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'timer', delayMs },
            branches: [{ conditions: [], actions: [
              { kind: 'adjust', variable: 'n', delta: 1 },
              { kind: 'navigate', screen: 'A' },
            ] }],
          },
        ],
      },
    ],
  };
}

test('到期时刻同时存在计时和点按，会话过期且两者均不执行', () => {
  // 每 100ms 自跳转：第 18000 次到点恰好等于到期时刻 TTL
  const project = timerProject(100);
  const session = createSession(project, 0);
  const result = session.advanceTo(TTL);
  // 只有严格早于 TTL 的计时触发：100..TTL-100，共 17999 次
  assert.equal(result.fired.length, TTL / 100 - 1);
  assert.equal(result.fired.at(-1)!.at, TTL - 100);
  assert.equal(session.getState().expired, true);
  assert.equal(session.getState().variables.n, TTL / 100 - 1);

  // 到期时刻的点按不执行、不能恢复会话
  const tapResult = session.tap(TTL, 'anything');
  assert.deepEqual(tapResult.fired, []);
  const state = session.getState();
  assert.equal(state.expired, true);
  assert.equal(state.variables.n, TTL / 100 - 1);
});

test('到期前的计时完整执行，但不能延长会话寿命', () => {
  const project = timerProject(100);
  const session = createSession(project, 0);
  // 推进到 TTL 前 1ms：计时照常触发
  const before = session.advanceTo(TTL - 1);
  assert.equal(before.fired.length, TTL / 100 - 1);
  assert.equal(session.getState().expired, false);
  // 下一步跨过到期时刻：期间活跃的计时并未刷新活动时间
  const after = session.advanceTo(TTL);
  assert.deepEqual(after.fired, []);
  assert.equal(session.getState().expired, true);
});

test('点按刷新活动时间（含未匹配规则的点按），计时/推进/查看不刷新', () => {
  const project: Project = {
    initialScreen: 'A',
    variables: [],
    screens: [
      {
        name: 'A',
        rules: [
          {
            trigger: { kind: 'tap', name: 'hit' },
            branches: [{ conditions: [], actions: [{ kind: 'navigate', screen: 'B' }] }],
          },
        ],
      },
      { name: 'B', rules: [] },
    ],
  };
  const session = createSession(project, 0);
  session.advanceTo(TTL - 1); // 推进不刷新
  session.getState(TTL - 1); // 查看不刷新
  session.tap(TTL - 1, 'no-such-rule'); // 未匹配点按也刷新
  assert.equal(session.getState().expired, false);

  // 新的到期时刻 = (TTL-1) + TTL；到达前仍有效
  session.advanceTo(2 * TTL - 2);
  assert.equal(session.getState().expired, false);
  // 到达新到期时刻：过期
  session.advanceTo(2 * TTL - 1);
  assert.equal(session.getState().expired, true);
});

test('过期后不能恢复，屏幕、变量、历史不再改变', () => {
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
      { name: 'B', rules: [] },
    ],
  };
  const session = createSession(project, 0);
  session.tap(100, 'go');
  const snapshot = session.getState();
  assert.equal(snapshot.screen, 'B');
  assert.deepEqual(snapshot.history, ['A']);

  session.advanceTo(100 + TTL);
  assert.equal(session.getState().expired, true);

  // 过期后的点按与推进全部无动作
  const tapResult = session.tap(100 + TTL + 1, 'go');
  assert.deepEqual(tapResult.fired, []);
  const advanceResult = session.advanceTo(100 + TTL + 1000);
  assert.deepEqual(advanceResult.fired, []);
  assert.deepEqual(session.getState(), {
    screen: 'B',
    variables: { n: 1 },
    history: ['A'],
    expired: true,
  });
});

test('getState(at) 可按给定时刻判定过期且不刷新活动时间', () => {
  const project: Project = { initialScreen: 'A', variables: [], screens: [{ name: 'A', rules: [] }] };
  const session = createSession(project, 0);
  assert.equal(session.getState(TTL - 1).expired, false);
  assert.equal(session.getState(TTL).expired, true);
  // 一旦过期不可恢复
  assert.equal(session.getState(TTL + 1000).expired, true);
});
