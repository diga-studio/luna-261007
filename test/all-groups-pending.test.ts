import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { MAX_GROUPS, VpnFailoverManager } from "../src/failover-manager";
import { TunnelRole } from "../src/types";
import { ControllableCallbacks, flush, S, T } from "./helpers";

const GROUP_IDS = Array.from({ length: MAX_GROUPS }, (_, i) => `g${i}`);

test("250 组准备全部悬置时，新健康变化与查询仍在 100ms 内完成", async () => {
  const cb = new ControllableCallbacks();
  const mgr = new VpnFailoverManager(cb, GROUP_IDS);

  // 每组主用成功一次 → 250 组全部目标主用、准备悬置
  for (const id of GROUP_IDS) {
    mgr.applyProbeResults(id, [S, T]);
  }
  assert.equal(cb.prepares.length, MAX_GROUPS);
  assert.ok(cb.prepares.every((p) => p.tunnel === TunnelRole.Primary));

  // 全量查询：250 组状态立即可读，不依赖任何准备完成
  const tQuery0 = performance.now();
  const all = mgr.getAllGroupStatus();
  const queryMs = performance.now() - tQuery0;
  assert.equal(all.length, MAX_GROUPS);
  for (const st of all) {
    assert.equal(st.target, TunnelRole.Primary);
    assert.equal(st.activeTunnel, null);
    assert.equal(st.preparePending, true);
  }
  assert.ok(queryMs < 100, `getAllGroupStatus took ${queryMs}ms`);

  // 任一组新探测结果：主用连续 3 次超时 → 目标切备用并立即发起新准备
  const victim = "g123";
  const tApply0 = performance.now();
  mgr.applyProbeResults(victim, [T, S]);
  mgr.applyProbeResults(victim, [T, S]);
  mgr.applyProbeResults(victim, [T, S]);
  const applyMs = performance.now() - tApply0;
  assert.ok(applyMs < 100, `applyProbeResults took ${applyMs}ms`);

  const st = mgr.getGroupStatus(victim);
  assert.equal(st.primaryUp, false);
  assert.equal(st.backupUp, true);
  assert.equal(st.target, TunnelRole.Backup);
  assert.equal(st.preparePending, true);
  assert.equal(cb.prepares.length, MAX_GROUPS + 1);
  const newPrepare = cb.prepares[cb.prepares.length - 1];
  assert.equal(newPrepare.groupId, victim);
  assert.equal(newPrepare.tunnel, TunnelRole.Backup);

  // 其他组不受干扰：目标仍为主用、准备仍悬置
  const other = mgr.getGroupStatus("g200");
  assert.equal(other.target, TunnelRole.Primary);
  assert.equal(other.preparePending, true);

  // 该组作废的主用准备晚到：只能释放，不影响新目标
  const stalePrimarySession = cb.completePrepare(123);
  await flush();
  const stAfter = mgr.getGroupStatus(victim);
  assert.equal(stAfter.target, TunnelRole.Backup);
  assert.equal(stAfter.activeTunnel, null);
  assert.deepEqual(cb.releases, [
    { groupId: victim, tunnel: TunnelRole.Primary, session: stalePrimarySession },
  ]);

  // 该组备用准备完成 → 正常切换
  const sBackup = cb.completePrepare(MAX_GROUPS);
  await flush();
  const stFinal = mgr.getGroupStatus(victim);
  assert.equal(stFinal.activeTunnel, TunnelRole.Backup);
  assert.equal(stFinal.activeSession, sBackup);
  assert.equal(stFinal.preparePending, false);
  assert.equal(cb.releaseCount(), 1);

  // 其余 249 组的悬置准备逐个完成，互不影响
  for (let i = 0; i < MAX_GROUPS; i++) {
    if (i === 123) continue;
    cb.completePrepare(i);
  }
  await flush();
  const allFinal = mgr.getAllGroupStatus();
  for (const st of allFinal) {
    assert.equal(st.preparePending, false);
    if (st.groupId === victim) {
      assert.equal(st.activeTunnel, TunnelRole.Backup);
    } else {
      assert.equal(st.activeTunnel, TunnelRole.Primary);
    }
  }
  assert.equal(cb.releaseCount(), 1); // 没有多余释放
});

test("构造参数校验", () => {
  const cb = new ControllableCallbacks();
  assert.throws(() => new VpnFailoverManager(cb, [...GROUP_IDS, "extra"]), RangeError);
  assert.throws(() => new VpnFailoverManager(cb, ["a", "a"]), /duplicate/);
  const mgr = new VpnFailoverManager(cb, ["a"]);
  assert.throws(() => mgr.applyProbeResults("nope", [S, S]), /unknown group/);
  assert.throws(() => mgr.applyProbeResults("a", [S]), RangeError);
  assert.throws(() => mgr.getGroupStatus("nope"), /unknown group/);
});
