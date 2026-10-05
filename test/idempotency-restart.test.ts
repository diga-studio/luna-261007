import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsentStore } from "../src/index.ts";
import type { CommandResult } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

test("replayed commands return first results after state changed and restart", async () => {
  const db = tempDb();
  try {
    let store = new ConsentStore(db.path);

    const appliedFirst = await store.submitPartialChoice({
      userId: "u1",
      requestId: "applied-cmd",
      baseRevision: 0,
      choices: { cookies: true },
    });
    const conflictFirst = await store.submitPartialChoice({
      userId: "u1",
      requestId: "conflict-cmd",
      baseRevision: 0,
      choices: { cookies: true, email_marketing: true },
    });
    const withdrawFirst = await store.withdrawAll("u1", "withdraw-cmd");
    assert.equal(appliedFirst.status, "applied");
    assert.equal(conflictFirst.status, "conflict");
    assert.equal(withdrawFirst.status, "applied");

    const later = await store.submitPartialChoice({
      userId: "u1",
      requestId: "later-cmd",
      baseRevision: withdrawFirst.snapshot.revision,
      choices: { personalization: true },
    });
    assert.equal(later.status, "applied");
    const historyBefore = await store.getAuditHistory("u1");
    await store.close();

    store = new ConsentStore(db.path);

    const appliedReplay = await store.submitPartialChoice({
      userId: "u1",
      requestId: "applied-cmd",
      baseRevision: 0,
      choices: { cookies: true },
    });
    const conflictReplay = await store.submitPartialChoice({
      userId: "u1",
      requestId: "conflict-cmd",
      baseRevision: 0,
      choices: { cookies: true, email_marketing: true },
    });
    const withdrawReplay = await store.withdrawAll("u1", "withdraw-cmd");

    assert.deepEqual(appliedReplay, appliedFirst);
    assert.deepEqual(conflictReplay, conflictFirst);
    assert.deepEqual(withdrawReplay, withdrawFirst);

    const historyAfter = await store.getAuditHistory("u1");
    assert.deepEqual(historyAfter, historyBefore);
    assert.equal(historyAfter.length, 3);

    const snapshot = await store.getSnapshot("u1");
    assert.equal(snapshot.revision, 3);
    assert.equal(snapshot.selections.personalization, true);
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("duplicate delivery within one session returns identical result object content", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    const command = {
      userId: "u1",
      requestId: "dup",
      baseRevision: 0,
      choices: { cookies: true },
    };
    const first: CommandResult = await store.submitPartialChoice(command);
    const second: CommandResult = await store.submitPartialChoice(command);
    assert.deepEqual(second, first);
    const history = await store.getAuditHistory("u1");
    assert.equal(history.length, 1);
    await store.close();
  } finally {
    db.cleanup();
  }
});
