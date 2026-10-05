import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationQueue } from "../src/queue.js";
import { LocalReceiver } from "../src/receiver.js";

interface Harness {
  dir: string;
  setNow: (ms: number) => void;
  getNow: () => number;
  openReceiver: (shouldFail?: (id: string, attempt: number) => boolean) => LocalReceiver;
  openQueue: (receiver: LocalReceiver) => NotificationQueue;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "secure-notify-recovery-"));
  let now = 0;
  return {
    dir,
    setNow: (ms) => {
      now = ms;
    },
    getNow: () => now,
    openReceiver: (shouldFail) =>
      new LocalReceiver(join(dir, "inbox.db"), { now: () => now, shouldFail }),
    openQueue: (receiver) => new NotificationQueue(join(dir, "queue.db"), receiver),
  };
}

test("crash after success landed but before queue confirmed: repeated recovery keeps one inbox message", async () => {
  const h = makeHarness();
  try {
    h.setNow(1_000);
    let receiver = h.openReceiver();
    let queue = h.openQueue(receiver);
    queue.enqueue("n1", "security alert", h.getNow());

    // The crashed process delivered and the receiver persisted the result,
    // but the queue never recorded it (process exit before the call returned).
    const landed = receiver.deliver("n1", 1, "security alert");
    assert.equal(landed.ok, true);
    queue.close();
    receiver.close();

    // First recovery: the queue adopts the landed result without redelivering.
    h.setNow(2_000);
    receiver = h.openReceiver();
    queue = h.openQueue(receiver);
    await queue.advance(h.getNow());
    let state = queue.get("n1");
    assert.equal(state?.status, "delivered");
    assert.equal(state?.attemptCount, 1);
    assert.equal(receiver.getResult("n1", 1)?.landedAt, 1_000);
    assert.equal(receiver.countMessages(), 1);
    queue.close();
    receiver.close();

    // Repeated recovery cycles: still delivered, still exactly one message.
    for (let i = 0; i < 3; i += 1) {
      h.setNow(3_000 + i * 1_000);
      receiver = h.openReceiver();
      queue = h.openQueue(receiver);
      await queue.advance(h.getNow());
      queue.enqueue("n1", "security alert", h.getNow());
      state = queue.get("n1");
      assert.equal(state?.status, "delivered");
      assert.equal(state?.attemptCount, 1);
      assert.equal(receiver.countMessages(), 1);
      assert.equal(receiver.getMessage("n1")?.body, "security alert");
      queue.close();
      receiver.close();
    }
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("crash after failure landed: backoff keeps original landing time; stops after 5th failure", async () => {
  const h = makeHarness();
  try {
    h.setNow(100);
    let receiver = h.openReceiver(() => true);
    let queue = h.openQueue(receiver);
    queue.enqueue("n1", "body", h.getNow());

    // Attempt 1 landed as a failure at t=100, then the process exited before
    // the queue recorded anything.
    const landed = receiver.deliver("n1", 1, "body");
    assert.deepEqual(landed, { ok: false, landedAt: 100 });
    queue.close();
    receiver.close();

    // Recovery happens much later; the backoff must still be computed from
    // the original landing time (t=100), not from the restart time.
    h.setNow(5_000);
    receiver = h.openReceiver(() => true);
    queue = h.openQueue(receiver);
    await queue.advance(h.getNow());
    let state = queue.get("n1");
    assert.equal(state?.status, "queued");
    assert.equal(state?.attemptCount, 1);
    assert.equal(state?.nextAttemptAt, 1_100);

    // The overdue attempt 2 runs immediately on the next advance.
    await queue.advance(h.getNow());
    state = queue.get("n1");
    assert.equal(state?.attemptCount, 2);
    assert.equal(state?.nextAttemptAt, 5_000 + 2_000);

    // Attempt 3 must not start before its boundary.
    h.setNow(6_999);
    await queue.advance(h.getNow());
    assert.equal(queue.get("n1")?.attemptCount, 2);

    h.setNow(7_000);
    await queue.advance(h.getNow());
    assert.equal(queue.get("n1")?.nextAttemptAt, 7_000 + 4_000);

    h.setNow(11_000);
    await queue.advance(h.getNow());
    assert.equal(queue.get("n1")?.nextAttemptAt, 11_000 + 8_000);

    h.setNow(19_000);
    await queue.advance(h.getNow());
    state = queue.get("n1");
    assert.equal(state?.status, "failed");
    assert.equal(state?.attemptCount, 5);
    assert.equal(state?.nextAttemptAt, null);

    // After the 5th failure nothing is ever delivered again, even across restarts.
    queue.close();
    receiver.close();
    h.setNow(1_000_000);
    receiver = h.openReceiver(() => true);
    queue = h.openQueue(receiver);
    await queue.advance(h.getNow());
    assert.equal(queue.get("n1")?.status, "failed");
    assert.equal(queue.get("n1")?.attemptCount, 5);
    assert.equal(receiver.getResult("n1", 6), undefined);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("read ack before the queue learns of delivery success: stays read after delivery completes and after restart", async () => {
  const h = makeHarness();
  try {
    h.setNow(500);
    let receiver = h.openReceiver();
    let queue = h.openQueue(receiver);
    queue.enqueue("n1", "alert body", h.getNow());

    // Delivery landed at the receiver, then the process exited before the
    // queue recorded it. The read ack reaches the queue first after restart.
    receiver.deliver("n1", 1, "alert body");
    queue.close();
    receiver.close();

    receiver = h.openReceiver();
    queue = h.openQueue(receiver);
    queue.ackRead("n1");
    assert.equal(queue.get("n1")?.status, "read");

    // Recovery adopts the landed success but must not downgrade read.
    await queue.advance(h.getNow());
    let state = queue.get("n1");
    assert.equal(state?.status, "read");
    assert.equal(state?.attemptCount, 1);
    assert.equal(receiver.countMessages(), 1);
    queue.close();
    receiver.close();

    // Another restart: still read, still one message, no new attempts.
    h.setNow(9_000);
    receiver = h.openReceiver();
    queue = h.openQueue(receiver);
    await queue.advance(h.getNow());
    state = queue.get("n1");
    assert.equal(state?.status, "read");
    assert.equal(state?.attemptCount, 1);
    assert.equal(receiver.getResult("n1", 2), undefined);
    assert.equal(receiver.countMessages(), 1);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("interruption without a landed result is not recorded as a failure", async () => {
  const h = makeHarness();
  try {
    h.setNow(0);
    const receiver = h.openReceiver();
    const queue = h.openQueue(receiver);
    queue.enqueue("n1", "body", 0);

    // Simulate a delivery that dies before the receiver persists anything.
    const crashingReceiver = {
      deliver: () => {
        throw new Error("process exit before landing");
      },
      getResult: (id: string, attempt: number) => receiver.getResult(id, attempt),
    };
    const crashedQueue = new NotificationQueue(join(h.dir, "queue.db"), crashingReceiver);
    await assert.rejects(crashedQueue.advance(0));
    crashedQueue.close();

    // No result landed: the attempt was not consumed, nothing was failed.
    assert.equal(receiver.getResult("n1", 1), undefined);
    const state = queue.get("n1");
    assert.equal(state?.status, "queued");
    assert.equal(state?.attemptCount, 0);

    // The same attempt number is retried and succeeds.
    await queue.advance(0);
    assert.equal(queue.get("n1")?.status, "delivered");
    assert.equal(queue.get("n1")?.attemptCount, 1);
    assert.equal(receiver.countMessages(), 1);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
