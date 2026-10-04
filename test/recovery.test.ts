import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, utc, MINUTE, waitFor } from './helpers.js';

const base = { id: 'n1', body: 'b', recipient: 'r' };

test('crash with unsaved delivery end state replays same attempt without consuming a retry', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svcA = h.open(h.pendingDeliver());
  svcA.submitNotification({ ...base, notBefore: 0, critical: true });
  void svcA.advance(t0);
  await waitFor(() => h.deliveries.length === 1);
  const firstAttemptId = h.deliveries[0]!.attemptId;

  const svcB = h.open();
  await svcB.advance(t0 + 1 * MINUTE);
  assert.equal(h.deliveries.length, 2, 'incomplete attempt is replayed after restart');
  assert.equal(h.deliveries[1]!.attemptId, firstAttemptId, 'replay reuses the same attempt id');

  const attempts = svcB.listAttempts('n1');
  assert.equal(attempts.length, 1, 'attempt count did not grow');
  assert.equal(attempts[0]!.id, firstAttemptId);
  assert.equal(attempts[0]!.firstStartedAt, t0, 'original first start time preserved');
  assert.notEqual(attempts[0]!.endedAt, null, 'end state saved after replay finished');

  await svcB.advance(t0 + 9 * MINUTE);
  assert.equal(h.deliveries.length, 2, 'retry clock still runs from original first start');
  await svcB.advance(t0 + 10 * MINUTE);
  assert.equal(h.deliveries.length, 3, 'next real attempt only after 10 minutes from first start');
  assert.notEqual(h.deliveries[2]!.attemptId, firstAttemptId);
  assert.equal(svcB.listAttempts('n1').length, 2);
  svcB.close();
});

test('repeated crashes keep replaying the same attempt id', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svcA = h.open(h.pendingDeliver());
  svcA.submitNotification({ ...base, notBefore: 0, critical: true });
  void svcA.advance(t0);
  await waitFor(() => h.deliveries.length === 1);
  const attemptId = h.deliveries[0]!.attemptId;

  const svcB = h.open(h.pendingDeliver());
  void svcB.advance(t0 + 1 * MINUTE);
  await waitFor(() => h.deliveries.length === 2);
  assert.equal(h.deliveries[1]!.attemptId, attemptId);

  const svcC = h.open();
  await svcC.advance(t0 + 2 * MINUTE);
  assert.equal(h.deliveries.length, 3);
  assert.equal(h.deliveries[2]!.attemptId, attemptId, 'still the same attempt after two crashes');
  assert.equal(svcC.listAttempts('n1').length, 1);
  svcC.close();
});

test('attempt with saved end state is not replayed on restart', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svcA = h.open();
  svcA.submitNotification({ ...base, notBefore: 0, critical: true });
  await svcA.advance(t0);
  assert.equal(h.deliveries.length, 1);
  svcA.close();

  const svcB = h.open();
  await svcB.advance(t0 + 1 * MINUTE);
  assert.equal(h.deliveries.length, 1, 'no immediate replay of a finished attempt');
  await svcB.advance(t0 + 10 * MINUTE);
  assert.equal(h.deliveries.length, 2, 'normal retry schedule resumes');
  assert.notEqual(h.deliveries[1]!.attemptId, h.deliveries[0]!.attemptId);
  svcB.close();
});

test('replay after restart obeys the delivery window for non-critical messages', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 17, 59);

  const svcA = h.open(h.pendingDeliver());
  svcA.submitNotification({ ...base, notBefore: 0, critical: false });
  void svcA.advance(t0);
  await waitFor(() => h.deliveries.length === 1);
  const attemptId = h.deliveries[0]!.attemptId;

  const svcB = h.open();
  await svcB.advance(utc(2026, 1, 5, 18, 30));
  assert.equal(h.deliveries.length, 1, 'replay blocked outside the window');
  await svcB.advance(utc(2026, 1, 6, 8, 0));
  assert.equal(h.deliveries.length, 2, 'replayed once the window opens');
  assert.equal(h.deliveries[1]!.attemptId, attemptId);
  svcB.close();
});
