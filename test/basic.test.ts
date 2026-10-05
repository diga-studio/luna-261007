import { test } from "node:test";
import assert from "node:assert/strict";
import { openService, reqId } from "./helpers.js";

test("新用户初始快照：全部拒绝，修订号 0", () => {
  const ctx = openService();
  try {
    const snap = ctx.service.getSnapshot("u1");
    assert.equal(snap.revision, 0);
    assert.deepEqual(snap.choices, {
      cookies: "rejected",
      emailMarketing: "rejected",
      dataSharing: "rejected",
      personalization: "rejected",
    });
    assert.deepEqual(ctx.service.getHistory("u1"), []);
  } finally {
    ctx.cleanup();
  }
});

test("部分选择只影响明确提交的类别", () => {
  const ctx = openService();
  try {
    const result = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "granted" },
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(result.snapshot.choices, {
      cookies: "granted",
      emailMarketing: "rejected",
      dataSharing: "rejected",
      personalization: "rejected",
    });
    assert.equal(result.snapshot.revision, 1);
  } finally {
    ctx.cleanup();
  }
});

test("多个页面从同一快照分别授权不同类别，应全部成功", () => {
  const ctx = openService();
  try {
    const base = ctx.service.getSnapshot("u1"); // revision 0
    const r1 = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: base.revision,
      choices: { cookies: "granted" },
    });
    const r2 = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: base.revision,
      choices: { emailMarketing: "granted" },
    });
    const r3 = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: base.revision,
      choices: { dataSharing: "granted", personalization: "granted" },
    });
    assert.equal(r1.status, "applied");
    assert.equal(r2.status, "applied");
    assert.equal(r3.status, "applied");
    const snap = ctx.service.getSnapshot("u1");
    assert.equal(snap.revision, 3);
    assert.deepEqual(snap.choices, {
      cookies: "granted",
      emailMarketing: "granted",
      dataSharing: "granted",
      personalization: "granted",
    });
  } finally {
    ctx.cleanup();
  }
});

test("同一类别被成功命令涉及后，旧快照授权冲突（即使最终值未变）", () => {
  const ctx = openService();
  try {
    // 快照在 revision 0；一条命令把 cookies 显式拒绝（值未变，但涉及该类别）
    const r1 = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "rejected" },
    });
    assert.equal(r1.status, "applied");
    // 旧弹窗基于 revision 0 授权 cookies → 冲突
    const r2 = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "granted" },
    });
    assert.equal(r2.status, "conflict");
    if (r2.status === "conflict") {
      assert.deepEqual(r2.conflicts, ["cookies"]);
      assert.equal(r2.snapshot.revision, 1);
    }
    // 无关类别的旧快照授权不冲突
    const r3 = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { emailMarketing: "granted" },
    });
    assert.equal(r3.status, "applied");
  } finally {
    ctx.cleanup();
  }
});

test("拒绝选择不因快照陈旧而冲突", () => {
  const ctx = openService();
  try {
    ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "granted", emailMarketing: "granted" },
    });
    // 基于 revision 0 的陈旧拒绝命令
    const r = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "rejected" },
    });
    assert.equal(r.status, "applied");
    assert.equal(r.snapshot.choices.cookies, "rejected");
    assert.equal(r.snapshot.choices.emailMarketing, "granted");
  } finally {
    ctx.cleanup();
  }
});

test("混合授权与拒绝的命令遇到一个授权冲突时，整条拒绝", () => {
  const ctx = openService();
  try {
    ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { emailMarketing: "granted" },
    }); // revision 1
    ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 1,
      choices: { cookies: "granted" },
    }); // revision 2，涉及 cookies
    // 基于 revision 1 的混合命令：cookies 授权冲突，emailMarketing 拒绝本可生效
    const r = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 1,
      choices: { cookies: "granted", emailMarketing: "rejected" },
    });
    assert.equal(r.status, "conflict");
    const snap = ctx.service.getSnapshot("u1");
    assert.equal(snap.revision, 2, "冲突命令不增加修订号");
    assert.equal(snap.choices.cookies, "granted");
    assert.equal(snap.choices.emailMarketing, "granted", "拒绝选择也不得部分生效");
    assert.equal(ctx.service.getHistory("u1").length, 2, "冲突命令不追加事件");
  } finally {
    ctx.cleanup();
  }
});

test("选择值未变化的成功命令也增加修订号并追加事件", () => {
  const ctx = openService();
  try {
    const r = ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "rejected" }, // 与初始值相同
    });
    assert.equal(r.status, "applied");
    assert.equal(r.snapshot.revision, 1);
    const history = ctx.service.getHistory("u1");
    assert.equal(history.length, 1);
    assert.equal(history[0].revision, 1);
    assert.deepEqual(history[0].touchedCategories, ["cookies"]);
    assert.equal(history[0].choicesAfter.cookies, "rejected");
  } finally {
    ctx.cleanup();
  }
});
