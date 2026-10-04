import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FailoverManager,
  MAX_GROUPS,
  type GroupStatus,
  type ProbeResult,
  type SessionCallbacks,
  type SessionHandle,
  type TunnelId,
} from '../src/index.js';

const ok = (tunnel: TunnelId): ProbeResult => ({ tunnel, outcome: 'success' });
const to = (tunnel: TunnelId): ProbeResult => ({ tunnel, outcome: 'timeout' });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface PrepareCall {
  groupId: string;
  tunnel: TunnelId;
  resolve: (session: SessionHandle) => void;
}

/** 可控的进程内会话回调：准备永不自动完成，释放全部记录。 */
class Harness implements SessionCallbacks {
  readonly prepares: PrepareCall[] = [];
  readonly released: SessionHandle[] = [];

  prepare(groupId: string, tunnel: TunnelId): Promise<SessionHandle> {
    return new Promise<SessionHandle>((resolve) => {
      this.prepares.push({ groupId, tunnel, resolve });
    });
  }

  release(session: SessionHandle): void {
    this.released.push(session);
  }

  lastPrepare(): PrepareCall {
    const call = this.prepares[this.prepares.length - 1];
    assert.ok(call, 'expected at least one prepare call');
    return call;
  }
}

function setup(): { manager: FailoverManager; h: Harness } {
  const h = new Harness();
  const manager = new FailoverManager(h);
  manager.addGroup('g1');
  return { manager, h };
}

function status(manager: FailoverManager, groupId = 'g1'): GroupStatus {
  return manager.getGroupStatus(groupId);
}

function assertStatus(
  actual: GroupStatus,
  expected: Partial<GroupStatus>,
): void {
  assert.deepEqual(
    {
      primaryAvailable: actual.primaryAvailable,
      backupAvailable: actual.backupAvailable,
      target: actual.target,
      activeTunnel: actual.activeTunnel,
      activeSession: actual.activeSession,
      preparingTunnel: actual.preparingTunnel,
    },
    {
      primaryAvailable: false,
      backupAvailable: false,
      target: null,
      activeTunnel: null,
      activeSession: null,
      preparingTunnel: null,
      ...expected,
    },
  );
}

test('初始状态：两隧道均不可用，无目标、无活动会话', () => {
  const { manager } = setup();
  assertStatus(status(manager), {});
});

test('健康判定：一次成功即可用，连续3次超时才不可用，成功清零计数', () => {
  const { manager, h } = setup();

  manager.reportProbeResults('g1', [to('primary'), to('backup')]);
  manager.reportProbeResults('g1', [to('primary'), to('backup')]);
  assertStatus(status(manager), {});

  manager.reportProbeResults('g1', [ok('primary'), ok('backup')]);
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    preparingTunnel: 'primary',
  });
  assert.equal(h.prepares.length, 1);

  // 前两次连续超时不改变可用状态
  manager.reportProbeResults('g1', [to('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  assert.equal(status(manager).primaryAvailable, true);
  // 一次成功清零连续超时
  manager.reportProbeResults('g1', [ok('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  assert.equal(status(manager).primaryAvailable, true);
  // 第三次超时判定不可用
  manager.reportProbeResults('g1', [to('primary')]);
  assertStatus(status(manager), {
    primaryAvailable: false,
    backupAvailable: true,
    target: 'backup',
    preparingTunnel: 'backup',
  });
});

test('目标在主备间连续往返，同一目标多次准备倒序完成，旧结果永不获得转发权', async () => {
  const { manager, h } = setup();

  // 主用可用 → 准备#1(primary)
  manager.reportProbeResults('g1', [ok('primary')]);
  assertStatus(status(manager), {
    primaryAvailable: true,
    target: 'primary',
    preparingTunnel: 'primary',
  });
  assert.deepEqual(h.prepares.map((p) => p.tunnel), ['primary']);

  h.lastPrepare().resolve('S1');
  await tick();
  assertStatus(status(manager), {
    primaryAvailable: true,
    target: 'primary',
    activeTunnel: 'primary',
    activeSession: 'S1',
  });
  assert.deepEqual(h.released, []);

  // 主用连续3次超时 → 活动会话立即撤销并释放，目标为空
  manager.reportProbeResults('g1', [to('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  assertStatus(status(manager), {
    primaryAvailable: true,
    target: 'primary',
    activeTunnel: 'primary',
    activeSession: 'S1',
  });
  manager.reportProbeResults('g1', [to('primary')]);
  assertStatus(status(manager), {});
  assert.deepEqual(h.released, ['S1']);

  // 备用可用 → 准备#2(backup)；主用又恢复 → 准备#3(primary)，#2 失效
  manager.reportProbeResults('g1', [ok('backup')]);
  manager.reportProbeResults('g1', [ok('primary')]);
  assert.deepEqual(h.prepares.map((p) => p.tunnel), ['primary', 'backup', 'primary']);
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    preparingTunnel: 'primary',
  });

  // 失效的 #2 晚到：只能释放，不得转发
  h.prepares[1]!.resolve('S2');
  await tick();
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    preparingTunnel: 'primary',
  });
  assert.deepEqual(h.released, ['S1', 'S2']);

  // 主用再次失效 → 准备#4(backup)，#3 失效；主用又恢复 → 准备#5(primary)，#4 失效
  manager.reportProbeResults('g1', [to('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  assertStatus(status(manager), {
    backupAvailable: true,
    target: 'backup',
    preparingTunnel: 'backup',
  });
  manager.reportProbeResults('g1', [ok('primary')]);
  assert.deepEqual(
    h.prepares.map((p) => p.tunnel),
    ['primary', 'backup', 'primary', 'backup', 'primary'],
  );

  // 同一目标(primary)的两次准备 #3、#5 倒序完成：先新的 #5，后旧的 #3
  h.prepares[4]!.resolve('S5');
  await tick();
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    activeTunnel: 'primary',
    activeSession: 'S5',
  });
  h.prepares[2]!.resolve('S3');
  await tick();
  // 旧结果不得夺回转发权，只能被释放
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    activeTunnel: 'primary',
    activeSession: 'S5',
  });
  assert.deepEqual(h.released, ['S1', 'S2', 'S3']);

  // 失效的 #4(backup) 晚到同样只能释放
  h.prepares[3]!.resolve('S4');
  await tick();
  assert.equal(status(manager).activeSession, 'S5');
  assert.deepEqual(h.released, ['S1', 'S2', 'S3', 'S4']);

  // 目标不变时，后续探测不重复发起准备、不重建活动会话
  manager.reportProbeResults('g1', [ok('primary'), ok('backup')]);
  manager.reportProbeResults('g1', [ok('primary')]);
  assert.equal(h.prepares.length, 5);
  assert.equal(status(manager).activeSession, 'S5');
  assert.deepEqual(h.released, ['S1', 'S2', 'S3', 'S4']);
});

test('备用活动期间主用恢复但准备迟迟不返回：备用持续转发，切换后旧会话只释放一次', async () => {
  const { manager, h } = setup();

  manager.reportProbeResults('g1', [ok('backup')]);
  assertStatus(status(manager), {
    backupAvailable: true,
    target: 'backup',
    preparingTunnel: 'backup',
  });
  h.lastPrepare().resolve('S1');
  await tick();
  assertStatus(status(manager), {
    backupAvailable: true,
    target: 'backup',
    activeTunnel: 'backup',
    activeSession: 'S1',
  });

  // 主用恢复：目标变为主用并发起准备，但准备迟迟不返回
  manager.reportProbeResults('g1', [ok('primary')]);
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    activeTunnel: 'backup',
    activeSession: 'S1',
    preparingTunnel: 'primary',
  });
  assert.equal(h.prepares.length, 2);

  // 多轮探测过去，准备仍未完成：备用持续可用，不重复准备，不释放 S1
  for (let i = 0; i < 5; i += 1) {
    manager.reportProbeResults('g1', [ok('primary'), ok('backup')]);
  }
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    activeTunnel: 'backup',
    activeSession: 'S1',
    preparingTunnel: 'primary',
  });
  assert.equal(h.prepares.length, 2);
  assert.deepEqual(h.released, []);

  // 准备最终成功：完成切换，旧会话 S1 恰好释放一次
  h.lastPrepare().resolve('S2');
  await tick();
  assertStatus(status(manager), {
    primaryAvailable: true,
    backupAvailable: true,
    target: 'primary',
    activeTunnel: 'primary',
    activeSession: 'S2',
  });
  assert.deepEqual(h.released, ['S1']);

  // 后续探测不再引发任何准备或释放
  manager.reportProbeResults('g1', [ok('primary'), ok('backup')]);
  assert.equal(h.prepares.length, 2);
  assert.deepEqual(h.released, ['S1']);
});

test('目标变回活动会话所属隧道时取消在途准备，晚到结果不得夺回转发权', async () => {
  const { manager, h } = setup();

  manager.reportProbeResults('g1', [ok('backup')]);
  h.lastPrepare().resolve('S1');
  await tick();
  assertStatus(status(manager), {
    backupAvailable: true,
    target: 'backup',
    activeTunnel: 'backup',
    activeSession: 'S1',
  });

  // 主用恢复 → 目标切主用，发起准备#2
  manager.reportProbeResults('g1', [ok('primary')]);
  assert.equal(h.prepares.length, 2);
  assert.equal(h.lastPrepare().tunnel, 'primary');

  // 主用再次失效 → 目标回到备用，正好是当前活动隧道：准备#2 失效，不重新准备
  manager.reportProbeResults('g1', [to('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  manager.reportProbeResults('g1', [to('primary')]);
  assertStatus(status(manager), {
    backupAvailable: true,
    target: 'backup',
    activeTunnel: 'backup',
    activeSession: 'S1',
  });
  assert.equal(h.prepares.length, 2);
  assert.deepEqual(h.released, []);

  // 准备#2 此刻才返回：失效准备只能释放，活动会话保持 S1
  h.lastPrepare().resolve('S2');
  await tick();
  assertStatus(status(manager), {
    backupAvailable: true,
    target: 'backup',
    activeTunnel: 'backup',
    activeSession: 'S1',
  });
  assert.deepEqual(h.released, ['S2']);
});

test('250组准备全部悬置时，新健康变化与查询仍即时生效', async () => {
  const h = new Harness();
  const manager = new FailoverManager(h);
  for (let i = 0; i < MAX_GROUPS; i += 1) {
    manager.addGroup(`g-${i}`);
  }
  for (let i = 0; i < MAX_GROUPS; i += 1) {
    manager.reportProbeResults(`g-${i}`, [ok('primary')]);
  }
  assert.equal(h.prepares.length, MAX_GROUPS);

  // 任一组的新探测结果立即反映：主用失效 → 目标为空、准备失效
  manager.reportProbeResults('g-100', [to('primary')]);
  manager.reportProbeResults('g-100', [to('primary')]);
  manager.reportProbeResults('g-100', [to('primary')]);
  assertStatus(status(manager, 'g-100'), {});
  // 备用恢复 → 立即发起新准备
  manager.reportProbeResults('g-100', [ok('backup')]);
  assertStatus(status(manager, 'g-100'), {
    backupAvailable: true,
    target: 'backup',
    preparingTunnel: 'backup',
  });
  assert.equal(h.prepares.length, MAX_GROUPS + 1);
  assert.equal(h.lastPrepare().groupId, 'g-100');

  // 一次查询全部组
  const start = performance.now();
  const all = manager.getAllStatus();
  const elapsed = performance.now() - start;
  assert.equal(all.length, MAX_GROUPS);
  assert.ok(elapsed < 100, `getAllStatus took ${elapsed}ms`);
  const g100 = all.find((s) => s.groupId === 'g-100');
  assert.equal(g100?.target, 'backup');
  const g0 = all.find((s) => s.groupId === 'g-0');
  assert.deepEqual(
    { target: g0?.target, preparing: g0?.preparingTunnel },
    { target: 'primary', preparing: 'primary' },
  );

  // 悬置准备不阻塞其他组完成切换
  const g0Prepare = h.prepares.find((p) => p.groupId === 'g-0');
  assert.ok(g0Prepare);
  g0Prepare.resolve('S-g0');
  await tick();
  assert.equal(status(manager, 'g-0').activeSession, 'S-g0');

  // g-100 最早那次主用准备已失效，晚到只能释放
  const stale = h.prepares.find((p) => p.groupId === 'g-100');
  assert.ok(stale);
  stale.resolve('S-stale');
  await tick();
  assert.deepEqual(h.released, ['S-stale']);
  assertStatus(status(manager, 'g-100'), {
    backupAvailable: true,
    target: 'backup',
    preparingTunnel: 'backup',
  });
});

test('管理约束：组数上限250，ID唯一，未知组报错', () => {
  const h = new Harness();
  const manager = new FailoverManager(h);
  for (let i = 0; i < MAX_GROUPS; i += 1) {
    manager.addGroup(`g-${i}`);
  }
  assert.throws(() => manager.addGroup('one-too-many'), /limit/);
  assert.throws(() => manager.addGroup('g-0'), /already exists/);
  assert.throws(() => manager.getGroupStatus('nope'), /unknown group/);
  assert.throws(() => manager.reportProbeResults('nope', []), /unknown group/);
});
