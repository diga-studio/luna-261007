import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, utc, MINUTE, waitFor } from './helpers.js';

const base = { id: 'n1', body: 'b', recipient: 'r' };

test('concurrent advance calls are serialized and never double-deliver', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await Promise.all([svc.advance(t0), svc.advance(t0), svc.advance(t0)]);
  assert.equal(h.deliveries.length, 1);
  assert.equal(svc.listAttempts('n1').length, 1);
  svc.close();
});

test('advance during an in-flight delivery waits and does not start a parallel call', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const svc = h.open((body, messageId, attemptId) => {
    h.record(body, messageId, attemptId);
    return gate;
  });
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  const first = svc.advance(t0);
  await waitFor(() => h.deliveries.length === 1);

  const second = svc.advance(t0 + 5 * MINUTE);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.deliveries.length, 1, 'no parallel delivery while the first call is in flight');

  release();
  await first;
  await second;
  assert.equal(h.deliveries.length, 1, 'same attempt is not re-run after the queued advance');
  svc.close();
});

test('receipt is saved even while the receiver has not returned', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const t0 = utc(2026, 1, 5, 10, 0);

  const svc = h.open(h.pendingDeliver());
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  void svc.advance(t0);
  await waitFor(() => h.deliveries.length === 1);
  const attemptId = h.deliveries[0]!.attemptId;

  svc.submitReceipt('n1', attemptId);
  assert.equal(svc.getNotification('n1')?.status, 'confirmed', 'receipt saved during in-flight call');

  const svc2 = h.open();
  await svc2.advance(t0 + 10 * MINUTE);
  assert.equal(h.deliveries.length, 1, 'confirmed message is not replayed after restart');
  svc2.close();
});
