import assert from "node:assert/strict";
import { test } from "node:test";
import { VpnFailoverManager } from "../src/failover-manager";
import { TunnelRole } from "../src/types";
import { ControllableCallbacks, flush, S, T } from "./helpers";

const G = "g1";

test("备用活动期间主用恢复但准备迟迟不返回，备用持续可用；切换后旧会话只释放一次", async () => {
  const cb = new ControllableCallbacks();
  const mgr = new VpnFailoverManager(cb, [G]);

  // 主用不可用、备用可用 → 目标备用，准备#1(备用)
  mgr.applyProbeResults(G, [T, S]);
  assert.equal(cb.prepares.length, 1);
  assert.equal(cb.prepares[0].tunnel, TunnelRole.Backup);

  // 备用准备完成 → 活动会话为备用
  const sBackup = cb.completePrepare(0);
  await flush();
  let st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Backup);
  assert.equal(st.activeTunnel, TunnelRole.Backup);
  assert.equal(st.activeSession, sBackup);
  assert.equal(cb.releaseCount(), 0);

  // 主用恢复 → 目标变为主用，发起准备#2(主用)，但备用会话继续转发
  mgr.applyProbeResults(G, [S, S]);
  st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(st.activeTunnel, TunnelRole.Backup);
  assert.equal(st.activeSession, sBackup);
  assert.equal(st.preparePending, true);
  assert.equal(cb.prepares.length, 2);
  assert.equal(cb.prepares[1].tunnel, TunnelRole.Primary);
  assert.equal(cb.releaseCount(), 0); // 不提前拆掉仍能工作的连接

  // 准备迟迟不返回：多轮探测后备用依然承载转发，且不重复发起准备
  for (let i = 0; i < 5; i++) {
    mgr.applyProbeResults(G, [S, S]);
  }
  st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(st.activeTunnel, TunnelRole.Backup);
  assert.equal(st.activeSession, sBackup);
  assert.equal(cb.prepares.length, 2);
  assert.equal(cb.releaseCount(), 0);

  // 主用准备最终完成 → 切换到主用，旧备用会话恰好释放一次
  const sPrimary = cb.completePrepare(1);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(st.activeTunnel, TunnelRole.Primary);
  assert.equal(st.activeSession, sPrimary);
  assert.equal(st.preparePending, false);
  assert.deepEqual(cb.releases, [
    { groupId: G, tunnel: TunnelRole.Backup, session: sBackup },
  ]);

  // 后续探测不再释放任何会话
  mgr.applyProbeResults(G, [S, S]);
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [S, S]);
  assert.equal(cb.releaseCount(), 1);
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeSession, sPrimary);
});

test("备用活动期间主用恢复又失效，晚到的主用准备不得夺走备用的转发权", async () => {
  const cb = new ControllableCallbacks();
  const mgr = new VpnFailoverManager(cb, [G]);

  mgr.applyProbeResults(G, [T, S]); // 目标 B → 准备#1(B)
  const sBackup = cb.completePrepare(0);
  await flush();

  mgr.applyProbeResults(G, [S, S]); // 主用恢复 → 目标 P → 准备#2(P) 悬置
  assert.equal(cb.prepares.length, 2);

  // 主用再次失效（连续 3 次超时）→ 目标回到备用，准备#2 作废
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [T, S]);
  let st = mgr.getGroupStatus(G);
  assert.equal(st.primaryUp, false);
  assert.equal(st.target, TunnelRole.Backup);
  assert.equal(st.activeTunnel, TunnelRole.Backup);
  assert.equal(st.activeSession, sBackup);
  assert.equal(st.preparePending, false); // 活动会话已属于目标，无需重新准备
  assert.equal(cb.prepares.length, 2);

  // 晚到的主用准备完成：只能释放，备用继续转发
  const sLatePrimary = cb.completePrepare(1);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeTunnel, TunnelRole.Backup);
  assert.equal(st.activeSession, sBackup);
  assert.deepEqual(cb.releases, [
    { groupId: G, tunnel: TunnelRole.Primary, session: sLatePrimary },
  ]);
});
