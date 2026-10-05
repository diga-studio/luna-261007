import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsentStore } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

test("multiple pages granting different categories from the same snapshot all succeed", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    const base = await store.getSnapshot("u1");
    assert.equal(base.revision, 0);

    const pageA = await store.submitPartialChoice({
      userId: "u1",
      requestId: "page-a",
      baseRevision: base.revision,
      choices: { cookies: true },
    });
    const pageB = await store.submitPartialChoice({
      userId: "u1",
      requestId: "page-b",
      baseRevision: base.revision,
      choices: { email_marketing: true },
    });
    const pageC = await store.submitPartialChoice({
      userId: "u1",
      requestId: "page-c",
      baseRevision: base.revision,
      choices: { data_sharing: true, personalization: true },
    });

    assert.equal(pageA.status, "applied");
    assert.equal(pageB.status, "applied");
    assert.equal(pageC.status, "applied");

    const snapshot = await store.getSnapshot("u1");
    assert.equal(snapshot.revision, 3);
    assert.deepEqual(snapshot.selections, {
      cookies: true,
      email_marketing: true,
      data_sharing: true,
      personalization: true,
    });
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("a grant conflict rejects the whole command including its rejections", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    const base = await store.getSnapshot("u1");

    const first = await store.submitPartialChoice({
      userId: "u1",
      requestId: "first",
      baseRevision: base.revision,
      choices: { cookies: true, email_marketing: true },
    });
    assert.equal(first.status, "applied");

    const stale = await store.submitPartialChoice({
      userId: "u1",
      requestId: "stale",
      baseRevision: base.revision,
      choices: { cookies: true, data_sharing: false },
    });
    assert.equal(stale.status, "conflict");
    assert.deepEqual(stale.conflictingCategories, ["cookies"]);
    assert.deepEqual(stale.snapshot, first.snapshot);

    const snapshot = await store.getSnapshot("u1");
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.selections, {
      cookies: true,
      email_marketing: true,
      data_sharing: false,
      personalization: false,
    });

    const history = await store.getAuditHistory("u1");
    assert.equal(history.length, 1);
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("rejections never conflict even on a stale snapshot", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    await store.submitPartialChoice({
      userId: "u1",
      requestId: "grant",
      baseRevision: 0,
      choices: { cookies: true },
    });

    const staleReject = await store.submitPartialChoice({
      userId: "u1",
      requestId: "stale-reject",
      baseRevision: 0,
      choices: { email_marketing: false, data_sharing: false },
    });
    assert.equal(staleReject.status, "applied");
    assert.equal(staleReject.snapshot.revision, 2);
    assert.equal(staleReject.snapshot.selections.cookies, true);
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("unrelated category updates do not block a grant", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    await store.submitPartialChoice({
      userId: "u1",
      requestId: "other-cat",
      baseRevision: 0,
      choices: { email_marketing: true },
    });

    const grant = await store.submitPartialChoice({
      userId: "u1",
      requestId: "grant-cookies",
      baseRevision: 0,
      choices: { cookies: true },
    });
    assert.equal(grant.status, "applied");
    assert.deepEqual(grant.snapshot.selections, {
      cookies: true,
      email_marketing: true,
      data_sharing: false,
      personalization: false,
    });
    await store.close();
  } finally {
    db.cleanup();
  }
});

test("same-value touch still conflicts a stale grant", async () => {
  const db = tempDb();
  try {
    const store = new ConsentStore(db.path);
    await store.submitPartialChoice({
      userId: "u1",
      requestId: "touch",
      baseRevision: 0,
      choices: { cookies: false },
    });

    const staleGrant = await store.submitPartialChoice({
      userId: "u1",
      requestId: "stale-grant",
      baseRevision: 0,
      choices: { cookies: true },
    });
    assert.equal(staleGrant.status, "conflict");
    assert.deepEqual(staleGrant.conflictingCategories, ["cookies"]);
    await store.close();
  } finally {
    db.cleanup();
  }
});
