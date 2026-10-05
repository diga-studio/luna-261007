import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { ConsentStore } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

test("100 snapshot reads over 100k events complete within 2 seconds", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    const eventCount = 100_000;
    for (let i = 0; i < eventCount; i += 1) {
      await store.submitPartialChoice({
        userId: "u1",
        requestId: `seed-${i}`,
        baseRevision: i,
        choices: { cookies: i % 2 === 0 },
      });
    }
    const history = await store.getAuditHistory("u1");
    assert.equal(history.length, eventCount);
    await store.close();

    const reopened = new ConsentStore(db.path);
    await reopened.getSnapshot("u1");
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) {
      const snapshot = await reopened.getSnapshot("u1");
      assert.equal(snapshot.revision, eventCount);
    }
    const elapsedMs = performance.now() - start;
    assert.ok(
      elapsedMs < 2000,
      `100 reads took ${elapsedMs.toFixed(1)}ms, expected under 2000ms`,
    );
    await reopened.close();
  } finally {
    db.cleanup();
  }
});
