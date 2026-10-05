import { test } from "node:test";
import assert from "node:assert/strict";
import { openService, reqId } from "./helpers.js";
import { ConsentService } from "../src/index.js";

test("重复投递返回首次结果，不重新执行", () => {
  const ctx = openService();
  try {
    const cmd = { requestId: reqId(), baseRevision: 0, choices: { cookies: "granted" as const } };
    const first = ctx.service.submitChoices("u1", cmd);
    // 状态继续变化
    ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 1,
      choices: { emailMarketing: "granted" },
    });
    const second = ctx.service.submitChoices("u1", cmd);
    assert.deepEqual(second, first, "重放必须返回首次处理时的结果与快照");
    assert.equal(ctx.service.getSnapshot("u1").revision, 2, "不得重新执行");
    assert.equal(ctx.service.getHistory("u1").length, 2, "事件数量不变");
  } finally {
    ctx.cleanup();
  }
});

test("冲突命令重复投递返回首次的冲突结果", () => {
  const ctx = openService();
  try {
    ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 0,
      choices: { cookies: "granted" },
    });
    const cmd = { requestId: reqId(), baseRevision: 0, choices: { cookies: "granted" as const } };
    const first = ctx.service.submitChoices("u1", cmd);
    assert.equal(first.status, "conflict");
    const second = ctx.service.submitChoices("u1", cmd);
    assert.deepEqual(second, first);
    assert.equal(ctx.service.getSnapshot("u1").revision, 1);
    assert.equal(ctx.service.getHistory("u1").length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("撤回命令重复投递幂等", () => {
  const ctx = openService();
  try {
    const cmd = { requestId: reqId() };
    const first = ctx.service.withdrawAll("u1", cmd);
    const second = ctx.service.withdrawAll("u1", cmd);
    assert.deepEqual(second, first);
    assert.equal(ctx.service.getSnapshot("u1").revision, 1);
    assert.equal(ctx.service.getHistory("u1").length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("正常重启后重放成功命令和冲突命令，返回值与首次一致，事件数量不变", () => {
  const ctx = openService();
  const appliedCmd = {
    requestId: reqId(),
    baseRevision: 0,
    choices: { cookies: "granted" as const, dataSharing: "granted" as const },
  };
  const conflictCmd = { requestId: reqId(), baseRevision: 0, choices: { cookies: "granted" as const } };
  const withdrawCmd = { requestId: reqId() };
  try {
    const appliedFirst = ctx.service.submitChoices("u1", appliedCmd); // rev 1
    const conflictFirst = ctx.service.submitChoices("u1", conflictCmd); // 冲突
    const withdrawFirst = ctx.service.withdrawAll("u1", withdrawCmd); // rev 2
    // 后续状态继续变化
    ctx.service.submitChoices("u1", {
      requestId: reqId(),
      baseRevision: 2,
      choices: { personalization: "granted" },
    }); // rev 3
    const eventCountBefore = ctx.service.getHistory("u1").length;
    ctx.service.close();

    // 重启（新实例，同一数据库文件）
    const reopened = new ConsentService({ path: ctx.dbPath });
    try {
      assert.deepEqual(reopened.submitChoices("u1", appliedCmd), appliedFirst);
      assert.deepEqual(reopened.submitChoices("u1", conflictCmd), conflictFirst);
      assert.deepEqual(reopened.withdrawAll("u1", withdrawCmd), withdrawFirst);
      assert.equal(reopened.getHistory("u1").length, eventCountBefore, "事件数量不变");
      assert.equal(reopened.getSnapshot("u1").revision, 3);
      assert.equal(reopened.getSnapshot("u1").choices.cookies, "rejected");
      assert.equal(reopened.getSnapshot("u1").choices.personalization, "granted");
    } finally {
      reopened.close();
    }
  } finally {
    ctx.cleanup();
  }
});
