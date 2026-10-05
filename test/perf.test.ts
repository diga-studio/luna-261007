import { test } from "node:test";
import assert from "node:assert/strict";
import { openService } from "./helpers.js";

// 非功能要求：单用户积累 10 万条事件后，连续读取当前快照 100 次总耗时不超过 2 秒
test("10 万条事件后连续读取快照 100 次总耗时 < 2 秒", { timeout: 300_000 }, () => {
  const ctx = openService();
  try {
    const EVENTS = 100_000;
    for (let i = 0; i < EVENTS; i += 1) {
      const result = ctx.service.submitChoices("u1", {
        requestId: `perf-${i}`,
        baseRevision: i,
        choices: { cookies: i % 2 === 0 ? "granted" : "rejected" },
      });
      assert.equal(result.status, "applied");
    }
    assert.equal(ctx.service.getHistory("u1").length, EVENTS);

    const start = performance.now();
    for (let i = 0; i < 100; i += 1) {
      const snap = ctx.service.getSnapshot("u1");
      assert.equal(snap.revision, EVENTS);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 2000, `100 次读取耗时 ${elapsed.toFixed(1)}ms，超过 2 秒`);
  } finally {
    ctx.cleanup();
  }
});
