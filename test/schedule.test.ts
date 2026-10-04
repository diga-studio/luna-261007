import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, utc, MINUTE } from './helpers.js';

const base = { id: 'n1', body: 'b', recipient: 'r' };

test('notification is not delivered before notBefore', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: utc(2026, 1, 5, 10), critical: true });
  await svc.advance(utc(2026, 1, 5, 9, 59));
  assert.equal(h.deliveries.length, 0);
  await svc.advance(utc(2026, 1, 5, 10));
  assert.equal(h.deliveries.length, 1);
  svc.close();
});

test('non-critical delivery only starts within 08:00-18:00 UTC window', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: false });
  await svc.advance(utc(2026, 1, 5, 7, 59));
  assert.equal(h.deliveries.length, 0);
  await svc.advance(utc(2026, 1, 5, 8, 0));
  assert.equal(h.deliveries.length, 1, '08:00 inclusive');
  svc.close();

  const h2 = harness();
  t.after(h2.cleanup);
  const svc2 = h2.open();
  svc2.submitNotification({ ...base, notBefore: 0, critical: false });
  await svc2.advance(utc(2026, 1, 5, 18, 0));
  assert.equal(h2.deliveries.length, 0, '18:00 exclusive');
  await svc2.advance(utc(2026, 1, 5, 17, 59));
  assert.equal(h2.deliveries.length, 1);
  svc2.close();
});

test('critical notification ignores the window', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(utc(2026, 1, 5, 23, 30));
  assert.equal(h.deliveries.length, 1);
  svc.close();
});

test('retry requires 10 minutes since previous attempt first start', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(utc(2026, 1, 5, 10, 0));
  assert.equal(h.deliveries.length, 1);
  await svc.advance(utc(2026, 1, 5, 10, 9, 59));
  assert.equal(h.deliveries.length, 1);
  await svc.advance(utc(2026, 1, 5, 10, 10));
  assert.equal(h.deliveries.length, 2);
  svc.close();
});

test('next attempt restarts its 10 minute clock from its actual start', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(utc(2026, 1, 5, 10, 0));
  await svc.advance(utc(2026, 1, 5, 10, 30));
  assert.equal(h.deliveries.length, 2, 'second attempt starts at 10:30, not backfilled to 10:10');
  await svc.advance(utc(2026, 1, 5, 10, 39, 59));
  assert.equal(h.deliveries.length, 2);
  await svc.advance(utc(2026, 1, 5, 10, 40));
  assert.equal(h.deliveries.length, 3);
  svc.close();
});

test('non-critical first attempt at 17:59 retries next day at 08:00, critical retries at 18:09', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ ...base, id: 'plain', notBefore: 0, critical: false });
  svc.submitNotification({ ...base, id: 'urgent', notBefore: 0, critical: true });
  await svc.advance(utc(2026, 1, 5, 17, 59));
  assert.equal(h.deliveries.length, 2);

  await svc.advance(utc(2026, 1, 5, 18, 9));
  const urgentRetries = h.deliveries.filter((d) => d.messageId === 'urgent');
  assert.equal(urgentRetries.length, 2, 'critical retried at 18:09');
  assert.equal(
    h.deliveries.filter((d) => d.messageId === 'plain').length,
    1,
    'non-critical cannot retry outside window',
  );

  await svc.advance(utc(2026, 1, 6, 7, 59));
  assert.equal(h.deliveries.filter((d) => d.messageId === 'plain').length, 1);
  await svc.advance(utc(2026, 1, 6, 8, 0));
  assert.equal(h.deliveries.filter((d) => d.messageId === 'plain').length, 2, 'retried at 08:00 next day');
  svc.close();
});

test('at most 4 attempts then message becomes exhausted', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  const t0 = utc(2026, 1, 5, 10, 0);
  await svc.advance(t0);
  await svc.advance(t0 + 10 * MINUTE);
  await svc.advance(t0 + 20 * MINUTE);
  await svc.advance(t0 + 30 * MINUTE);
  assert.equal(h.deliveries.length, 4);
  assert.equal(svc.getNotification('n1')?.status, 'active');
  await svc.advance(t0 + 40 * MINUTE);
  assert.equal(h.deliveries.length, 4, 'no fifth attempt');
  assert.equal(svc.getNotification('n1')?.status, 'exhausted');
  await svc.advance(t0 + 400 * MINUTE);
  assert.equal(h.deliveries.length, 4);
  const attempts = svc.listAttempts('n1');
  assert.equal(attempts.length, 4);
  assert.ok(new Set(attempts.map((a) => a.id)).size === 4, 'each attempt has a unique id');
  svc.close();
});

test('attempt is queryable before the delivery call and ended state is recorded', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  let seenDuringCall: unknown = null;
  const svc = h.open((body, messageId, attemptId) => {
    seenDuringCall = svc
      .listAttempts(messageId)
      .find((a) => a.id === attemptId && a.endedAt === null) ?? null;
  });
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(utc(2026, 1, 5, 10, 0));
  assert.ok(seenDuringCall !== null, 'attempt row exists before deliver is invoked');
  const attempts = svc.listAttempts('n1');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.seq, 1);
  assert.equal(attempts[0]?.firstStartedAt, utc(2026, 1, 5, 10, 0));
  assert.notEqual(attempts[0]?.endedAt, null, 'end state persisted after call finished');
  assert.equal(attempts[0]?.endError, null);
  svc.close();
});

test('throwing deliver function still counts as ended and does not confirm', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open(() => {
    throw new Error('smtp down');
  });
  svc.submitNotification({ ...base, notBefore: 0, critical: true });
  await svc.advance(utc(2026, 1, 5, 10, 0));
  const attempts = svc.listAttempts('n1');
  assert.equal(attempts[0]?.endError, 'smtp down');
  assert.notEqual(attempts[0]?.endedAt, null);
  assert.equal(svc.getNotification('n1')?.status, 'active');
  await svc.advance(utc(2026, 1, 5, 10, 10));
  assert.equal(svc.listAttempts('n1').length, 2, 'retry after failed call');
  svc.close();
});
