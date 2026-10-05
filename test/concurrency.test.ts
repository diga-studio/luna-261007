import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsentStore } from "../src/index.ts";
import type { Category, Snapshot } from "../src/index.ts";
import { CATEGORIES } from "../src/index.ts";
import { snapshotAtRevision, tempDb } from "./helpers.ts";

function pseudoRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test("200 concurrent calls across instances serialize into a consistent history", async () => {
  const db = tempDb();
  try {
    const storeA = new ConsentStore(db.path);
    const storeB = new ConsentStore(db.path);
    const stores = [storeA, storeB];
    const rand = pseudoRandom(42);
    const observedSnapshots: Snapshot[] = [];

    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i += 1) {
      const store = stores[i % stores.length];
      const category: Category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)];
      const grant = rand() < 0.5;
      const baseRevision = Math.floor(rand() * 3);
      calls.push(
        store.submitPartialChoice({
          userId: "u1",
          requestId: `req-${i}`,
          baseRevision,
          choices: { [category]: grant },
        }),
      );
      if (i % 5 === 0) {
        calls.push(
          store.getSnapshot("u1").then((snapshot) => {
            observedSnapshots.push(snapshot);
          }),
        );
      }
    }
    const results = await Promise.all(calls);
    void results;

    const history = await storeA.getAuditHistory("u1");
    const finalSnapshot = await storeB.getSnapshot("u1");

    assert.equal(finalSnapshot.revision, history.length);
    for (let revision = 1; revision <= history.length; revision += 1) {
      assert.equal(history[revision - 1].revision, revision);
      const reconstructed = snapshotAtRevision(history, revision);
      assert.deepEqual(
        reconstructed.selections,
        history[revision - 1].selectionsAfter,
        `reconstruction mismatch at revision ${revision}`,
      );
    }
    assert.deepEqual(
      finalSnapshot.selections,
      snapshotAtRevision(history, finalSnapshot.revision).selections,
    );
    for (const observed of observedSnapshots) {
      assert.deepEqual(
        observed.selections,
        snapshotAtRevision(history, observed.revision).selections,
        `snapshot at revision ${observed.revision} mixed values`,
      );
    }

    await storeA.close();
    await storeB.close();
  } finally {
    db.cleanup();
  }
});

test("concurrent duplicate deliveries of the same request resolve identically", async () => {
  const db = tempDb();
  try {
    const storeA = new ConsentStore(db.path);
    const storeB = new ConsentStore(db.path);
    const command = {
      userId: "u1",
      requestId: "same-request",
      baseRevision: 0,
      choices: { cookies: true },
    };
    const [first, second] = await Promise.all([
      storeA.submitPartialChoice(command),
      storeB.submitPartialChoice(command),
    ]);
    assert.deepEqual(second, first);
    const history = await storeA.getAuditHistory("u1");
    assert.equal(history.length, 1);
    await storeA.close();
    await storeB.close();
  } finally {
    db.cleanup();
  }
});
