import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationQueue } from "../src/queue.js";
import { LocalReceiver } from "../src/receiver.js";

interface Harness {
  dir: string;
  queueDb: string;
  inboxDb: string;
  setNow: (ms: number) => void;
  getNow: () => number;
  openReceiver: (shouldFail?: (id: string, attempt: number) => boolean) => LocalReceiver;
  openQueue: (receiver: LocalReceiver) => NotificationQueue;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "secure-notify-queue-"));
  let now = 0;
  return {
    dir,
    queueDb: join(dir, "queue.db"),
    inboxDb: join(dir, "inbox.db"),
    setNow: (ms) => {
      now = ms;
    },
    getNow: () => now,
    openReceiver: (shouldFail) => new LocalReceiver(join(dir, "inbox.db"), { now: () => now, shouldFail }),
    openQueue: (receiver) => new NotificationQueue(join(dir, "queue.db"), receiver),
  };
}

test("enqueue then advance delivers immediately; state is queryable", async () => {
  const h = makeHarness();
  try {
    h.setNow(1_000);
    const receiver = h.openReceiver();
    const queue = h.openQueue(receiver);
    queue.enqueue("n1", "rendered body", h.getNow());
    assert.equal(queue.get("n1")?.status, "queued");
    assert.equal(queue.get("missing"), undefined);

    await queue.advance(h.getNow());
    const state = queue.get("n1");
    assert.equal(state?.status, "delivered");
    assert.equal(state?.attemptCount, 1);
    assert.equal(state?.nextAttemptAt, null);
    assert.equal(receiver.getMessage("n1")?.body, "rendered body");
    assert.equal(receiver.countMessages(), 1);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("duplicate enqueue never resets attempts, backoff, or terminal state", async () => {
  const h = makeHarness();
  try {
    const receiver = h.openReceiver((_id, attempt) => attempt === 1);
    const queue = h.openQueue(receiver);
    queue.enqueue("n1", "body", 0);
    await queue.advance(0);
    assert.equal(queue.get("n1")?.attemptCount, 1);
    assert.equal(queue.get("n1")?.nextAttemptAt, 1_000);

    queue.enqueue("n1", "other body", 500);
    assert.equal(queue.get("n1")?.attemptCount, 1);
    assert.equal(queue.get("n1")?.nextAttemptAt, 1_000);
    assert.equal(queue.get("n1")?.body, "body");

    await queue.advance(1_000);
    assert.equal(queue.get("n1")?.status, "delivered");
    queue.enqueue("n1", "other body", 2_000);
    assert.equal(queue.get("n1")?.status, "delivered");
    assert.equal(queue.get("n1")?.attemptCount, 2);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

  test("backoff boundaries 1/2/4/8s are exact; never delivers early; stops after 5 failures", async () => {
  const h = makeHarness();
  try {
    h.setNow(10_000);
    const receiver = h.openReceiver(() => true);
    const queue = h.openQueue(receiver);
    queue.enqueue("n1", "body", h.getNow());

    const expectedWaits = [1_000, 2_000, 4_000, 8_000];
    let landedAt = 10_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      h.setNow(landedAt);
      await queue.advance(landedAt);
      const state = queue.get("n1");
      assert.equal(state?.status, "queued");
      assert.equal(state?.attemptCount, attempt);
      assert.equal(state?.nextAttemptAt, landedAt + expectedWaits[attempt - 1]);

      // One ms before the boundary: no new attempt may start.
      await queue.advance(landedAt + expectedWaits[attempt - 1] - 1);
      assert.equal(queue.get("n1")?.attemptCount, attempt);
      landedAt = landedAt + expectedWaits[attempt - 1];
    }

    // 5th failure is terminal.
    await queue.advance(landedAt);
    const state = queue.get("n1");
    assert.equal(state?.status, "failed");
    assert.equal(state?.attemptCount, 5);
    assert.equal(state?.nextAttemptAt, null);

    // No further delivery ever happens.
    await queue.advance(landedAt + 1_000_000);
    assert.equal(queue.get("n1")?.attemptCount, 5);
    assert.equal(receiver.getResult("n1", 6), undefined);
    assert.equal(receiver.countMessages(), 0);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("success on a later attempt becomes delivered and stops scheduling", async () => {
  const h = makeHarness();
  try {
    const receiver = h.openReceiver((_id, attempt) => attempt < 3);
    const queue = h.openQueue(receiver);
    queue.enqueue("n1", "body", 0);
    await queue.advance(0);
    await queue.advance(1_000);
    await queue.advance(3_000);
    const state = queue.get("n1");
    assert.equal(state?.status, "delivered");
    assert.equal(state?.attemptCount, 3);
    assert.equal(receiver.countMessages(), 1);

    await queue.advance(1_000_000);
    assert.equal(queue.get("n1")?.status, "delivered");
    assert.equal(receiver.getResult("n1", 4), undefined);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("read ack is idempotent and absorbing", async () => {
  const h = makeHarness();
  try {
    const receiver = h.openReceiver();
    const queue = h.openQueue(receiver);
    queue.enqueue("n1", "body", 0);
    await queue.advance(0);
    assert.equal(queue.get("n1")?.status, "delivered");

    queue.ackRead("n1");
    queue.ackRead("n1");
    assert.equal(queue.get("n1")?.status, "read");

    await queue.advance(1_000);
    queue.enqueue("n1", "body", 2_000);
    assert.equal(queue.get("n1")?.status, "read");
    assert.equal(queue.get("n1")?.attemptCount, 1);
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("ackRead and enqueue may happen while a delivery is still in flight", async () => {
  const h = makeHarness();
  try {
    const receiver = h.openReceiver();
    const queue = h.openQueue(receiver);
    queue.enqueue("n1", "body", 0);

    // Wrap the receiver so the delivery stays in flight until released,
    // and signals once the receiver has actually been entered.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slowReceiver = {
      deliver: async (id: string, attempt: number, message: string) => {
        entered();
        await gate;
        return receiver.deliver(id, attempt, message);
      },
      getResult: (id: string, attempt: number) => receiver.getResult(id, attempt),
    };
    const slowQueue = new NotificationQueue(h.queueDb, slowReceiver);
    slowQueue.enqueue("n1", "body", 0);

    const pending = slowQueue.advance(0);
    await deliveryStarted;
    // While the delivery has not returned: enqueue and read ack both work.
    slowQueue.enqueue("n2", "second", 0);
    slowQueue.ackRead("n1");
    assert.equal(slowQueue.get("n1")?.status, "read");
    release();
    await pending;

    // The in-flight success must not downgrade the read state.
    const state = slowQueue.get("n1");
    assert.equal(state?.status, "read");
    assert.equal(state?.attemptCount, 1);
    assert.equal(receiver.countMessages(), 1);

    await slowQueue.advance(0);
    assert.equal(slowQueue.get("n2")?.status, "delivered");
    slowQueue.close();
    queue.close();
    receiver.close();
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
