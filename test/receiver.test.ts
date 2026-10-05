import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalReceiver } from "../src/receiver.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "secure-notify-receiver-"));
}

test("deliver persists result and message; same attempt returns original result and landing time", () => {
  const dir = makeDir();
  try {
    let now = 1_000;
    const receiver = new LocalReceiver(join(dir, "inbox.db"), { now: () => now });

    const first = receiver.deliver("n1", 1, "hello");
    assert.deepEqual(first, { ok: true, landedAt: 1_000 });

    now = 9_999;
    const again = receiver.deliver("n1", 1, "changed body");
    assert.deepEqual(again, { ok: true, landedAt: 1_000 });

    assert.deepEqual(receiver.getMessage("n1"), {
      notificationId: "n1",
      body: "hello",
      landedAt: 1_000,
    });
    assert.equal(receiver.countMessages(), 1);
    receiver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("results and messages survive reopening the database", () => {
  const dir = makeDir();
  const dbPath = join(dir, "inbox.db");
  try {
    const first = new LocalReceiver(dbPath, { now: () => 500 });
    first.deliver("n1", 1, "persisted");
    first.close();

    const second = new LocalReceiver(dbPath, { now: () => 700 });
    assert.deepEqual(second.getResult("n1", 1), { ok: true, landedAt: 500 });
    assert.equal(second.getMessage("n1")?.body, "persisted");
    assert.equal(second.deliver("n1", 1, "ignored").landedAt, 500);
    assert.equal(second.countMessages(), 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failures persist without a message; a later successful attempt keeps a single message", () => {
  const dir = makeDir();
  try {
    let now = 0;
    const receiver = new LocalReceiver(join(dir, "inbox.db"), {
      now: () => now,
      shouldFail: (_id, attempt) => attempt === 1,
    });

    now = 100;
    assert.deepEqual(receiver.deliver("n1", 1, "body"), { ok: false, landedAt: 100 });
    assert.equal(receiver.getMessage("n1"), undefined);
    assert.equal(receiver.countMessages(), 0);

    now = 200;
    assert.deepEqual(receiver.deliver("n1", 2, "body"), { ok: true, landedAt: 200 });
    now = 300;
    assert.deepEqual(receiver.deliver("n1", 3, "body"), { ok: true, landedAt: 300 });
    assert.equal(receiver.countMessages(), 1);
    assert.equal(receiver.getMessage("n1")?.landedAt, 200);
    receiver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
