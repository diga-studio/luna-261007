import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchiveNotifier } from "../src/index.js";
import type { DeliverFn } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
/** 2026-01-05 00:00 UTC */
const DAY1 = Date.UTC(2026, 0, 5);
const at = (dayOffset: number, hour: number, minute = 0, second = 0) =>
  DAY1 + dayOffset * DAY + hour * 60 * MIN + minute * MIN + second * 1000;

interface DeliverCall {
  body: string;
  messageId: string;
  attemptId: string;
}

function makeHarness(deliver?: DeliverFn) {
  const dir = mkdtempSync(join(tmpdir(), "notifier-"));
  const dbPath = join(dir, "test.db");
  const calls: DeliverCall[] = [];
  let counter = 0;
  const nextAttemptId = () => `attempt-${++counter}`;
  const open = (fn?: DeliverFn) =>
    new ArchiveNotifier({
      dbPath,
      nextAttemptId,
      deliver:
        fn ??
        ((body: string, messageId: string, attemptId: string) => {
          calls.push({ body, messageId, attemptId });
        }),
    });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dbPath, calls, open, cleanup };
}

const tick = () => new Promise((r) => setImmediate(r));

test("resubmitting the same id is a no-op and never resets progress", async () => {
  const h = makeHarness();
  const n = h.open();
  const input = { id: "n1", body: "b", recipient: "r", notBefore: at(0, 9), critical: true };
  n.submitNotification(input, at(0, 8));
  await n.advance(at(0, 9));
  assert.equal(h.calls.length, 1);
  n.submitNotification(input, at(0, 9, 30)); // identical: no-op
  n.submitNotification(input, at(0, 9, 40));
  assert.equal(n.listAttempts("n1").length, 1);
  assert.throws(() =>
    n.submitNotification({ ...input, body: "different" }, at(0, 9, 50)),
  );
  await n.advance(at(0, 9, 5));
  assert.equal(h.calls.length, 1);
  n.close();
  h.cleanup();
});

test("notification is not delivered before its scheduled time", async () => {
  const h = makeHarness();
  const n = h.open();
  n.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 10), critical: true },
    at(0, 8),
  );
  await n.advance(at(0, 9, 59));
  assert.equal(h.calls.length, 0);
  await n.advance(at(0, 10));
  assert.equal(h.calls.length, 1);
  n.close();
  h.cleanup();
});

test("crash after receiver saw the delivery but before end state saved: replay keeps attempt id and count", async () => {
  const resolvers: Array<() => void> = [];
  const h = makeHarness();
  const seen: DeliverCall[] = [];
  // First process: delivery call starts but its end state is never saved
  // (the returned promise never resolves, simulating a crash mid-call).
  const crashed = h.open((body, messageId, attemptId) => {
    seen.push({ body, messageId, attemptId });
    return new Promise<void>((res) => {
      resolvers.push(res);
    });
  });
  crashed.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 9), critical: true },
    at(0, 8),
  );
  const inflight = crashed.advance(at(0, 9));
  await tick();
  assert.equal(seen.length, 1); // receiver already saw the delivery
  const firstAttemptId = seen[0].attemptId;
  assert.equal(crashed.listAttempts("n1").length, 1);
  assert.equal(crashed.listAttempts("n1")[0].callEnded, false);
  // --- simulated process exit: no close(), promise left pending ---

  // Restart on the same database.
  const n = h.open();
  await n.advance(at(0, 9, 1));
  const attempts = n.listAttempts("n1");
  assert.equal(attempts.length, 1, "replay must not add an attempt");
  assert.equal(attempts[0].id, firstAttemptId, "replay reuses the same attempt id");
  assert.equal(attempts[0].firstStartedAt, at(0, 9), "first start time is preserved");
  assert.equal(h.calls.length, 1, "replayed with the same attempt id");
  assert.equal(h.calls[0].attemptId, firstAttemptId);
  assert.equal(attempts[0].callEnded, true);

  // Restart again: the saved end state must not trigger another replay.
  const n2 = h.open();
  await n2.advance(at(0, 9, 2));
  assert.equal(h.calls.length, 1, "saved end state must not be replayed");
  n2.close();
  n.close();
  resolvers[0]?.();
  await inflight.catch(() => {});
  h.cleanup();
});

test("non-critical notification waits for the 08:00-18:00 UTC window; critical does not", async () => {
  const h = makeHarness();
  const n = h.open();
  n.submitNotification(
    { id: "plain", body: "b", recipient: "r", notBefore: at(0, 17, 59), critical: false },
    at(0, 8),
  );
  n.submitNotification(
    { id: "urgent", body: "b", recipient: "r", notBefore: at(0, 17, 59), critical: true },
    at(0, 8),
  );
  // Neither may start before 08:00 even if due.
  const h2 = makeHarness();
  const n2 = h2.open();
  n2.submitNotification(
    { id: "early", body: "b", recipient: "r", notBefore: at(0, 7, 30), critical: false },
    at(0, 7),
  );
  await n2.advance(at(0, 7, 30));
  assert.equal(h2.calls.length, 0, "non-critical cannot start before 08:00");
  await n2.advance(at(0, 8));
  assert.equal(h2.calls.length, 1);

  // First delivery at 17:59 for both.
  await n.advance(at(0, 17, 59));
  assert.deepEqual(
    h.calls.map((c) => c.messageId).sort(),
    ["plain", "urgent"],
  );

  // 10 minutes later: critical retries at 18:09, non-critical may not.
  await n.advance(at(0, 18, 9));
  const urgentAttempts = n.listAttempts("urgent");
  assert.equal(urgentAttempts.length, 2, "critical retries at 18:09");
  assert.equal(n.listAttempts("plain").length, 1, "non-critical blocked after 18:00");

  // Still blocked just before 08:00 next day; allowed at 08:00.
  await n.advance(at(1, 7, 59));
  assert.equal(n.listAttempts("plain").length, 1);
  await n.advance(at(1, 8, 0));
  const plainAttempts = n.listAttempts("plain");
  assert.equal(plainAttempts.length, 2, "non-critical retries at next 08:00");
  assert.equal(plainAttempts[1].firstStartedAt, at(1, 8, 0));

  // Retry clock restarts from the actual start of the previous attempt.
  await n.advance(at(1, 8, 9));
  assert.equal(n.listAttempts("plain").length, 2);
  await n.advance(at(1, 8, 10));
  assert.equal(n.listAttempts("plain").length, 3);
  n.close();
  n2.close();
  h.cleanup();
  h2.cleanup();
});

test("retry cadence: 4 attempts max, 10 minute gaps, then exhausted", async () => {
  const h = makeHarness();
  const n = h.open();
  n.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 9), critical: true },
    at(0, 8),
  );
  await n.advance(at(0, 9));
  assert.equal(n.listAttempts("n1").length, 1);
  await n.advance(at(0, 9, 9));
  assert.equal(n.listAttempts("n1").length, 1, "gap not yet 10 minutes");
  await n.advance(at(0, 9, 10));
  assert.equal(n.listAttempts("n1").length, 2);
  await n.advance(at(0, 9, 20));
  await n.advance(at(0, 9, 30));
  assert.equal(n.listAttempts("n1").length, 4);
  await n.advance(at(0, 9, 39));
  assert.equal(n.getNotification("n1")!.status, "pending");
  await n.advance(at(0, 9, 40));
  assert.equal(n.getNotification("n1")!.status, "exhausted");
  const callsAfterExhaustion = h.calls.length;
  await n.advance(at(0, 10));
  await n.advance(at(1, 10));
  assert.equal(h.calls.length, callsAfterExhaustion, "no deliveries after exhaustion");
  n.close();
  h.cleanup();
});

test("receipt for an old attempt arrives before the new delivery returns", async () => {
  let release: (() => void) | null = null;
  const h = makeHarness();
  const n = h.open((body, messageId, attemptId) => {
    h.calls.push({ body, messageId, attemptId });
    if (h.calls.length === 2) {
      // Second delivery stays in flight until we release it.
      return new Promise<void>((res) => {
        release = res;
      });
    }
  });
  n.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 9), critical: true },
    at(0, 8),
  );
  await n.advance(at(0, 9));
  const firstAttemptId = h.calls[0].attemptId;

  const inflight = n.advance(at(0, 9, 10));
  await tick();
  assert.equal(h.calls.length, 2, "second delivery in flight");

  // Receipt referencing the FIRST attempt lands before the call returns.
  const result = n.submitReceipt("rcpt-1", firstAttemptId, at(0, 9, 10, 500));
  assert.deepEqual(result, { kind: "confirmed", notificationId: "n1" });
  assert.equal(n.getNotification("n1")!.status, "confirmed");

  release!();
  await inflight;
  // The in-flight call may end, but must not revert the confirmation.
  assert.equal(n.getNotification("n1")!.status, "confirmed");
  assert.equal(n.listAttempts("n1")[1].callEnded, true);

  // Repeated advance and restarts never deliver again.
  await n.advance(at(0, 9, 20));
  const n2 = h.open();
  await n2.advance(at(0, 9, 30));
  await n2.advance(at(1, 12));
  assert.equal(h.calls.length, 2);
  n2.close();
  n.close();
  h.cleanup();
});

test("valid receipt after exhaustion still confirms; no further deliveries ever", async () => {
  const h = makeHarness();
  const n = h.open();
  n.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 9), critical: true },
    at(0, 8),
  );
  await n.advance(at(0, 9));
  await n.advance(at(0, 9, 10));
  await n.advance(at(0, 9, 20));
  await n.advance(at(0, 9, 30));
  await n.advance(at(0, 9, 40));
  assert.equal(n.getNotification("n1")!.status, "exhausted");
  assert.equal(h.calls.length, 4);

  const oldAttemptId = n.listAttempts("n1")[1].id;
  const result = n.submitReceipt("rcpt-late", oldAttemptId, at(0, 9, 41));
  assert.deepEqual(result, { kind: "confirmed", notificationId: "n1" });
  assert.equal(n.getNotification("n1")!.status, "confirmed");

  await n.advance(at(0, 10));
  const n2 = h.open();
  await n2.advance(at(0, 11));
  await n2.advance(at(2, 12));
  assert.equal(h.calls.length, 4, "no deliveries after confirmation");
  n2.close();
  n.close();
  h.cleanup();
});

test("duplicate and invalid receipts have no effect", async () => {
  const h = makeHarness();
  const n = h.open();
  n.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 9), critical: true },
    at(0, 8),
  );
  await n.advance(at(0, 9));
  const attemptId = n.listAttempts("n1")[0].id;

  assert.deepEqual(n.submitReceipt("r-x", "no-such-attempt", at(0, 9, 1)), { kind: "invalid" });
  assert.equal(n.getNotification("n1")!.status, "pending");
  assert.deepEqual(n.submitReceipt("r-1", attemptId, at(0, 9, 2)), {
    kind: "confirmed",
    notificationId: "n1",
  });
  assert.deepEqual(n.submitReceipt("r-1", attemptId, at(0, 9, 3)), { kind: "duplicate" });
  assert.equal(n.getNotification("n1")!.status, "confirmed");
  n.close();
  h.cleanup();
});

test("delivery function throwing still ends the call; retry policy applies", async () => {
  let failures = 0;
  const h = makeHarness(() => {
    failures++;
    if (failures === 1) throw new Error("boom");
  });
  const n = h.open();
  n.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 9), critical: true },
    at(0, 8),
  );
  await n.advance(at(0, 9));
  assert.equal(n.listAttempts("n1")[0].callEnded, true);
  assert.equal(n.getNotification("n1")!.status, "pending");
  await n.advance(at(0, 9, 10));
  assert.equal(n.listAttempts("n1").length, 2);
  n.close();
  h.cleanup();
});

test("crash replay of a non-critical notification still obeys the delivery window", async () => {
  const h = makeHarness();
  // First process: non-critical delivery starts at 17:59, end state never saved.
  const crashed = h.open(() => new Promise<void>(() => {}));
  crashed.submitNotification(
    { id: "n1", body: "b", recipient: "r", notBefore: at(0, 17, 59), critical: false },
    at(0, 8),
  );
  void crashed.advance(at(0, 17, 59));
  await tick();
  assert.equal(crashed.listAttempts("n1").length, 1);
  const attemptId = crashed.listAttempts("n1")[0].id;
  // --- simulated process exit ---

  const n = h.open();
  await n.advance(at(0, 18, 30));
  assert.equal(h.calls.length, 0, "replay blocked outside the window");
  await n.advance(at(1, 7, 59));
  assert.equal(h.calls.length, 0);
  await n.advance(at(1, 8, 0));
  assert.equal(h.calls.length, 1, "replayed at next 08:00");
  assert.equal(h.calls[0].attemptId, attemptId, "replay reuses the same attempt id");
  assert.equal(n.listAttempts("n1").length, 1);
  n.close();
  h.cleanup();
});
