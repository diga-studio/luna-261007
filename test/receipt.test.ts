import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, utc, MINUTE, waitFor } from './helpers.js';

const base = { id: 'n1', body: 'b', recipient: 'r' };

test('receipt for an old attempt arrives before the new delivery call returns', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(t0);
  const firstAttemptId = h.deliveries[0]!.attemptId;

  let releaseSecond!: () => void;
  const secondCall = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const svc2 = h.open((body, messageId, attemptId) => {
    h.record(body, messageId, attemptId);
    return secondCall;
  });
  svc.close();
  const advancing = svc2.advance(t0 + 10 * MINUTE);
  await waitFor(() => h.deliveries.length === 2);

  svc2.submitReceipt('n1', firstAttemptId);
  assert.equal(svc2.getNotification('n1')?.status, 'confirmed');

  releaseSecond();
  await advancing;
  const attempts = svc2.listAttempts('n1');
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[1]!.endedAt, null, 'in-flight call is allowed to finish');
  assert.equal(svc2.getNotification('n1')?.status, 'confirmed', 'finished call must not unconfirm');

  await svc2.advance(t0 + 20 * MINUTE);
  await svc2.advance(t0 + 400 * MINUTE);
  assert.equal(h.deliveries.length, 2, 'no new delivery after confirmation');
  svc2.close();

  const svc3 = h.open();
  await svc3.advance(t0 + 800 * MINUTE);
  assert.equal(h.deliveries.length, 2, 'no delivery after restart either');
  assert.equal(svc3.getNotification('n1')?.status, 'confirmed');
  svc3.close();
});

test('receipt arriving after exhaustion still confirms and stops everything', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(t0);
  await svc.advance(t0 + 10 * MINUTE);
  await svc.advance(t0 + 20 * MINUTE);
  await svc.advance(t0 + 30 * MINUTE);
  await svc.advance(t0 + 40 * MINUTE);
  assert.equal(h.deliveries.length, 4);
  assert.equal(svc.getNotification('n1')?.status, 'exhausted');

  const secondAttemptId = svc.listAttempts('n1')[1]!.id;
  svc.submitReceipt('n1', secondAttemptId);
  assert.equal(svc.getNotification('n1')?.status, 'confirmed');

  await svc.advance(t0 + 50 * MINUTE);
  svc.close();
  const svc2 = h.open();
  await svc2.advance(t0 + 900 * MINUTE);
  assert.equal(h.deliveries.length, 4, 'no delivery after post-exhaustion confirmation');
  assert.equal(svc2.getNotification('n1')?.status, 'confirmed');
  svc2.close();
});

test('duplicate receipt has no extra effect', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(t0);
  const attemptId = h.deliveries[0]!.attemptId;
  svc.submitReceipt('n1', attemptId);
  svc.submitReceipt('n1', attemptId);
  assert.equal(svc.getNotification('n1')?.status, 'confirmed');
  await svc.advance(t0 + 10 * MINUTE);
  assert.equal(h.deliveries.length, 1);
  svc.close();
});

test('receipt for unknown message or attempt is rejected', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  svc.submitNotification({ ...base, id: 'n2', notBefore: 0, critical: true });
  await svc.advance(t0);
  const attemptOfN1 = svc.listAttempts('n1')[0]!.id;

  assert.throws(() => svc.submitReceipt('nope', attemptOfN1));
  assert.throws(() => svc.submitReceipt('n1', 'no-such-attempt'));
  assert.throws(() => svc.submitReceipt('n2', attemptOfN1), 'attempt of another message');
  assert.equal(svc.getNotification('n1')?.status, 'active');
  assert.equal(svc.getNotification('n2')?.status, 'active');
  svc.close();
});

test('receipt referencing any started attempt is valid, not just the latest', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(t0);
  await svc.advance(t0 + 10 * MINUTE);
  await svc.advance(t0 + 20 * MINUTE);
  const firstAttemptId = svc.listAttempts('n1')[0]!.id;
  svc.submitReceipt('n1', firstAttemptId);
  assert.equal(svc.getNotification('n1')?.status, 'confirmed');
  svc.close();
});
