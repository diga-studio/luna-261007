import assert from "node:assert/strict";
import { test } from "node:test";
import { VpnFailoverManager } from "../src/failover-manager";
import { TunnelRole } from "../src/types";
import { ControllableCallbacks, flush, S, T } from "./helpers";

const G = "g1";

test("目标在主备之间连续往返，晚到的准备结果永不获得转发权", async () => {
  const cb = new ControllableCallbacks();
  const mgr = new VpnFailoverManager(cb, [G]);

  // 初始：两条隧道均不可用，无目标、无活动会话、无准备
  let st = mgr.getGroupStatus(G);
  assert.equal(st.target, null);
  assert.equal(st.activeTunnel, null);
  assert.equal(st.activeSession, null);
  assert.equal(st.preparePending, false);

  // 主用成功 → 目标主用，发起准备#1
  mgr.applyProbeResults(G, [S, T]);
  st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(st.activeTunnel, null);
  assert.equal(st.preparePending, true);
  assert.equal(cb.prepares.length, 1);
  assert.equal(cb.prepares[0].tunnel, TunnelRole.Primary);

  // 主用第 1、2 次超时：可用状态不变，不重复发起准备
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [T, S]);
  st = mgr.getGroupStatus(G);
  assert.equal(st.primaryUp, true);
  assert.equal(st.backupUp, true);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(cb.prepares.length, 1);

  // 主用第 3 次超时 → 主用失效，目标切到备用，准备#1 作废，发起准备#2
  mgr.applyProbeResults(G, [T, S]);
  st = mgr.getGroupStatus(G);
  assert.equal(st.primaryUp, false);
  assert.equal(st.target, TunnelRole.Backup);
  assert.equal(cb.prepares.length, 2);
  assert.equal(cb.prepares[1].tunnel, TunnelRole.Backup);

  // 晚到的准备#1（主用）完成：只能被释放，不得成为活动会话
  const s1 = cb.completePrepare(0);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeTunnel, null);
  assert.equal(st.activeSession, null);
  assert.deepEqual(cb.releases, [{ groupId: G, tunnel: TunnelRole.Primary, session: s1 }]);

  // 主用恢复 → 目标回到主用，准备#2 作废，发起准备#3
  mgr.applyProbeResults(G, [S, T]);
  st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(cb.prepares.length, 3);
  assert.equal(cb.prepares[2].tunnel, TunnelRole.Primary);

  // 晚到的准备#2（备用）完成：只能被释放
  const s2 = cb.completePrepare(1);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeTunnel, null);
  assert.deepEqual(cb.releases, [
    { groupId: G, tunnel: TunnelRole.Primary, session: s1 },
    { groupId: G, tunnel: TunnelRole.Backup, session: s2 },
  ]);

  // 当前有效的准备#3 完成：完成切换，活动会话为主用 s3
  const s3 = cb.completePrepare(2);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(st.activeTunnel, TunnelRole.Primary);
  assert.equal(st.activeSession, s3);
  assert.equal(st.preparePending, false);
  assert.equal(cb.releaseCount(), 2);

  // 目标不变，后续探测不重复发起准备、不重建活动会话
  mgr.applyProbeResults(G, [S, S]);
  mgr.applyProbeResults(G, [T, T]);
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeSession, s3);
  assert.equal(cb.prepares.length, 3);

  // 两条隧道各连续 3 次超时 → 全部失效，活动会话被撤销并恰好释放一次
  mgr.applyProbeResults(G, [T, T]);
  mgr.applyProbeResults(G, [T, T]);
  mgr.applyProbeResults(G, [T, T]);
  st = mgr.getGroupStatus(G);
  assert.equal(st.primaryUp, false);
  assert.equal(st.backupUp, false);
  assert.equal(st.target, null);
  assert.equal(st.activeTunnel, null);
  assert.equal(st.activeSession, null);
  assert.deepEqual(cb.releases, [
    { groupId: G, tunnel: TunnelRole.Primary, session: s1 },
    { groupId: G, tunnel: TunnelRole.Backup, session: s2 },
    { groupId: G, tunnel: TunnelRole.Primary, session: s3 },
  ]);
});

test("同一目标的多次准备倒序完成，旧结果永不获得转发权", async () => {
  const cb = new ControllableCallbacks();
  const mgr = new VpnFailoverManager(cb, [G]);

  // 在主备之间来回摆动，积累 5 次准备（P/B/P/B/P），仅最后一次有效
  mgr.applyProbeResults(G, [S, T]); // 目标 P → 准备#1(P)
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [T, S]); // P 失效 → 目标 B → 准备#2(B)
  mgr.applyProbeResults(G, [S, T]); // 目标 P → 准备#3(P)
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [T, S]);
  mgr.applyProbeResults(G, [T, S]); // P 再次失效 → 目标 B → 准备#4(B)
  mgr.applyProbeResults(G, [S, T]); // 目标 P → 准备#5(P)

  assert.equal(cb.prepares.length, 5);
  assert.deepEqual(
    cb.prepares.map((p) => p.tunnel),
    [
      TunnelRole.Primary,
      TunnelRole.Backup,
      TunnelRole.Primary,
      TunnelRole.Backup,
      TunnelRole.Primary,
    ],
  );
  let st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(st.activeTunnel, null);

  // 倒序完成：最新的准备#5 先完成 → 获得转发权
  const s5 = cb.completePrepare(4);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeTunnel, TunnelRole.Primary);
  assert.equal(st.activeSession, s5);
  assert.equal(cb.releaseCount(), 0);

  // 同一目标（主用）的旧准备#3、#1 随后完成：只能释放，不得夺权
  const s3 = cb.completePrepare(2);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeSession, s5);
  assert.deepEqual(cb.releases, [{ groupId: G, tunnel: TunnelRole.Primary, session: s3 }]);

  const s1 = cb.completePrepare(0);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.activeSession, s5);
  assert.deepEqual(cb.releases, [
    { groupId: G, tunnel: TunnelRole.Primary, session: s3 },
    { groupId: G, tunnel: TunnelRole.Primary, session: s1 },
  ]);

  // 备用的旧准备#4、#2 完成：同样只能释放，活动会话不变
  const s4 = cb.completePrepare(3);
  const s2 = cb.completePrepare(1);
  await flush();
  st = mgr.getGroupStatus(G);
  assert.equal(st.target, TunnelRole.Primary);
  assert.equal(st.activeTunnel, TunnelRole.Primary);
  assert.equal(st.activeSession, s5);
  assert.deepEqual(cb.releases, [
    { groupId: G, tunnel: TunnelRole.Primary, session: s3 },
    { groupId: G, tunnel: TunnelRole.Primary, session: s1 },
    { groupId: G, tunnel: TunnelRole.Backup, session: s4 },
    { groupId: G, tunnel: TunnelRole.Backup, session: s2 },
  ]);
});
