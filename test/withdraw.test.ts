import { test } from "node:test";
import assert from "node:assert/strict";
import { openService, reqId } from "./helpers.js";
import { CATEGORIES } from "../src/index.js";

test("撤回把四个类别全部设为拒绝，并涉及全部类别（原本已全部拒绝也如此）", () => {
  const ctx = openService();
  try {
    // 初始已全部拒绝，撤回仍应成功并追加事件
    const r = ctx.service.withdrawAll("u1", { requestId: reqId() });
    assert.equal(r.status, "applied");
    assert.equal(r.snapshot.revision, 1);
    assert.deepEqual(r.snapshot.choices, {
      cookies: "rejected",
      emailMarketing: "rejected",
      dataSharing: "rejected",
      personalization: "rejected",
    });
    const history = ctx.service.getHistory("u1");
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, "withdrawAll");
    assert.deepEqual(
      [...history[0].touchedCategories].sort(),
      [...CATEGORIES].sort(),
    );
    // 撤回之后，基于 revision 0 的旧授权必须冲突（撤回涉及全部类别）
    const stale = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { personalization: "granted" },
    });
    assert.equal(stale.status, "conflict");
  } finally {
    ctx.cleanup();
  }
});

test("先授权再撤回回到原值：旧授权不能恢复权限，新快照授权可以成功", () => {
  const ctx = openService();
  try {
    const s0 = ctx.service.getSnapshot("u1"); // revision 0
    // 页面 A 基于 s0 授权 cookies（弹窗仍打开着）
    const grant = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: s0.revision,
      choices: { cookies: "granted" },
    });
    assert.equal(grant.status, "applied"); // revision 1
    // 偏好中心一键撤回
    const withdraw = ctx.service.withdrawAll("u1", { requestId: reqId() });
    assert.equal(withdraw.status, "applied"); // revision 2
    assert.equal(withdraw.snapshot.choices.cookies, "rejected");
    // 旧弹窗（仍拿着 revision 0 的快照）提交授权 → 冲突，不能恢复权限
    const staleGrant = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: s0.revision,
      choices: { cookies: "granted" },
    });
    assert.equal(staleGrant.status, "conflict");
    assert.equal(ctx.service.getSnapshot("u1").choices.cookies, "rejected");
    // 撤回之后读到新快照的用户仍可重新授权
    const s2 = ctx.service.getSnapshot("u1");
    const regrant = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: s2.revision,
      choices: { cookies: "granted", dataSharing: "granted" },
    });
    assert.equal(regrant.status, "applied");
    assert.equal(regrant.snapshot.choices.cookies, "granted");
    assert.equal(regrant.snapshot.choices.dataSharing, "granted");
  } finally {
    ctx.cleanup();
  }
});

test("撤回与旧授权交错：撤回后基于撤回前快照的授权全部冲突", () => {
  const ctx = openService();
  try {
    ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "granted", emailMarketing: "granted" },
    }); // revision 1
    const s1 = ctx.service.getSnapshot("u1");
    ctx.service.withdrawAll("u1", { requestId: reqId() }); // revision 2
    // 基于 revision 1 授权任何类别都冲突（撤回涉及全部类别）
    for (const category of CATEGORIES) {
      const r = ctx.service.submitChoices("u1", {
        requestId: reqId(),
        baseRevision: s1.revision,
        choices: { [category]: "granted" },
      });
      assert.equal(r.status, "conflict", `${category} 应冲突`);
    }
    // 但基于 revision 1 的拒绝仍可生效
    const reject = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: s1.revision,
      choices: { cookies: "rejected" },
    });
    assert.equal(reject.status, "applied");
  } finally {
    ctx.cleanup();
  }
});
