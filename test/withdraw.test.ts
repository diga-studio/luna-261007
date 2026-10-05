import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsentStore } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

test("withdraw resets all categories and touches all four even when already rejected", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    const before = await store.getSnapshot("u1");
    assert.deepEqual(before.selections, {
      cookies: false,
      email_marketing: false,
      data_sharing: false,
      personalization: false,
    });

    const withdrawn = await store.withdrawAll("u1", "w1");
    assert.equal(withdrawn.status, "applied");
    assert.equal(withdrawn.snapshot.revision, 1);
    assert.deepEqual(withdrawn.snapshot.selections, before.selections);

    const history = await store.getAuditHistory("u1");
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, "withdraw_all");
    assert.deepEqual(history[0].touchedCategories, [
      "cookies",
      "email_marketing",
      "data_sharing",
      "personalization",
    ]);
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("stale grant from before a withdraw cannot restore permissions", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    const base = await store.getSnapshot("u1");

    const granted = await store.submitPartialChoice({
      userId: "u1",
      requestId: "grant",
      baseRevision: base.revision,
      choices: { data_sharing: true },
    });
    assert.equal(granted.status, "applied");

    const withdrawn = await store.withdrawAll("u1", "w1");
    assert.equal(withdrawn.snapshot.revision, 2);
    assert.equal(withdrawn.snapshot.selections.data_sharing, false);

    const staleGrant = await store.submitPartialChoice({
      userId: "u1",
      requestId: "stale-popup",
      baseRevision: base.revision,
      choices: { data_sharing: true },
    });
    assert.equal(staleGrant.status, "conflict");
    assert.deepEqual(staleGrant.conflictingCategories, ["data_sharing"]);

    const snapshot = await store.getSnapshot("u1");
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.selections.data_sharing, false);
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("grant then withdraw returns to original values and still counts as touching", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    await store.submitPartialChoice({
      userId: "u1",
      requestId: "grant",
      baseRevision: 0,
      choices: { personalization: true },
    });
    const withdrawn = await store.withdrawAll("u1", "w1");
    assert.equal(withdrawn.snapshot.selections.personalization, false);

    const staleGrant = await store.submitPartialChoice({
      userId: "u1",
      requestId: "stale",
      baseRevision: 1,
      choices: { personalization: true },
    });
    assert.equal(staleGrant.status, "conflict");
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("a fresh snapshot after withdraw can grant again", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    await store.submitPartialChoice({
      userId: "u1",
      requestId: "grant",
      baseRevision: 0,
      choices: { cookies: true, email_marketing: true },
    });
    const withdrawn = await store.withdrawAll("u1", "w1");

    const regrant = await store.submitPartialChoice({
      userId: "u1",
      requestId: "regrant",
      baseRevision: withdrawn.snapshot.revision,
      choices: { cookies: true },
    });
    assert.equal(regrant.status, "applied");
    assert.equal(regrant.snapshot.revision, 3);
    assert.deepEqual(regrant.snapshot.selections, {
      cookies: true,
      email_marketing: false,
      data_sharing: false,
      personalization: false,
    });
    await store.close();
  } finally {
    db.cleanup();
  }
});
