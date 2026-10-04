import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, utc } from './helpers.js';

test('submit stores notification and exposes it via query', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({
    id: 'n1',
    body: 'retention warning',
    recipient: 'compliance@example.com',
    notBefore: utc(2026, 1, 5, 10),
    critical: false,
  });
  const view = svc.getNotification('n1');
  assert.deepEqual(view, {
    id: 'n1',
    body: 'retention warning',
    recipient: 'compliance@example.com',
    notBefore: utc(2026, 1, 5, 10),
    critical: false,
    status: 'active',
  });
  assert.equal(svc.getNotification('missing'), null);
  svc.close();
});

test('duplicate submit with identical content is a no-op and keeps progress', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  const input = {
    id: 'n1',
    body: 'b',
    recipient: 'r',
    notBefore: utc(2026, 1, 5, 10),
    critical: true,
  };
  svc.submitNotification(input);
  await svc.advance(utc(2026, 1, 5, 10));
  assert.equal(h.deliveries.length, 1);
  svc.submitNotification(input);
  svc.submitNotification(input);
  assert.equal(svc.listAttempts('n1').length, 1);
  await svc.advance(utc(2026, 1, 5, 10, 1));
  assert.equal(h.deliveries.length, 1, 'no extra delivery after duplicate submit');
  svc.close();
});

test('duplicate submit with different content is rejected', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  svc.submitNotification({ id: 'n1', body: 'b', recipient: 'r', notBefore: 0, critical: false });
  assert.throws(() =>
    svc.submitNotification({ id: 'n1', body: 'changed', recipient: 'r', notBefore: 0, critical: false }),
  );
  assert.throws(() =>
    svc.submitNotification({ id: 'n1', body: 'b', recipient: 'other', notBefore: 0, critical: false }),
  );
  assert.throws(() =>
    svc.submitNotification({ id: 'n1', body: 'b', recipient: 'r', notBefore: 5, critical: false }),
  );
  assert.throws(() =>
    svc.submitNotification({ id: 'n1', body: 'b', recipient: 'r', notBefore: 0, critical: true }),
  );
  svc.close();
});

test('submit survives restart', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc1 = h.open();
  svc1.submitNotification({ id: 'n1', body: 'b', recipient: 'r', notBefore: 0, critical: false });
  svc1.close();
  const svc2 = h.open();
  const view = svc2.getNotification('n1');
  assert.equal(view?.status, 'active');
  svc2.close();
});

test('invalid submit input is rejected', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const svc = h.open();
  assert.throws(() =>
    svc.submitNotification({ id: '', body: 'b', recipient: 'r', notBefore: 0, critical: false }),
  );
  assert.throws(() =>
    svc.submitNotification({ id: 'n1', body: 'b', recipient: '', notBefore: 0, critical: false }),
  );
  assert.throws(() =>
    svc.submitNotification({ id: 'n1', body: 'b', recipient: 'r', notBefore: Number.NaN, critical: false }),
  );
  svc.close();
});
