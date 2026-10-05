import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccessReviewService,
  createService,
  REVIEW_PERIOD_MS,
} from '../src/index.js';

const T0 = 1_700_000_000_000;

function newService(): AccessReviewService {
  return createService(':memory:');
}

test('two overdue cycles: grant stays suspended until the last overdue entry is confirmed', () => {
  const svc = newService();
  const grantId = svc.grantAccess({ user: 'alice', database: 'db1', role: 'reader' }, T0);

  const cycle1 = svc.openReviewCycle('db1', T0 + 1_000);
  const cycle2 = svc.openReviewCycle('db1', T0 + 2_000);
  assert.equal(cycle1.entryIds.length, 1);
  assert.equal(cycle2.entryIds.length, 1);

  const deadline1 = T0 + 1_000 + REVIEW_PERIOD_MS;
  const deadline2 = T0 + 2_000 + REVIEW_PERIOD_MS;

  // One millisecond before the first deadline: still active.
  assert.equal(svc.getGrantStatus(grantId, deadline1 - 1).status, 'active');
  // At the exact deadline instant: pending entry becomes a suspension cause.
  assert.equal(svc.getGrantStatus(grantId, deadline1).status, 'suspended');
  // One millisecond before the second deadline: still suspended via cycle 2.
  assert.equal(svc.getGrantStatus(grantId, deadline2 - 1).status, 'suspended');
  assert.equal(svc.getGrantStatus(grantId, deadline2).status, 'suspended');

  // Confirming one overdue cycle does not lift the other's suspension.
  svc.submitDecisions([{ entryId: cycle1.entryIds[0], decision: 'confirm' }], deadline2 + 1);
  assert.equal(svc.getGrantStatus(grantId, deadline2 + 1).status, 'suspended');

  // Confirming the last overdue entry restores availability.
  svc.submitDecisions([{ entryId: cycle2.entryIds[0], decision: 'confirm' }], deadline2 + 2);
  const final = svc.getGrantStatus(grantId, deadline2 + 2);
  assert.equal(final.status, 'active');
  assert.equal(final.suspended, false);
  assert.equal(final.revoked, false);
});

test('revoke then re-grant: late decisions from old cycles never affect the new instance', () => {
  const svc = newService();
  const oldGrant = svc.grantAccess({ user: 'bob', database: 'db1', role: 'writer' }, T0);

  const cycle1 = svc.openReviewCycle('db1', T0 + 100);
  const cycle2 = svc.openReviewCycle('db1', T0 + 200);

  // Cycle 1 revokes the grant.
  svc.submitDecisions([{ entryId: cycle1.entryIds[0], decision: 'revoke' }], T0 + 300);
  assert.equal(svc.getGrantStatus(oldGrant, T0 + 300).status, 'revoked');

  // Re-grant creates an independent new instance.
  const newGrant = svc.grantAccess({ user: 'bob', database: 'db1', role: 'writer' }, T0 + 400);
  assert.notEqual(newGrant, oldGrant);
  assert.equal(svc.getGrantStatus(newGrant, T0 + 400).status, 'active');

  // Old cycle 2 (bound to the old instance) later confirms: no effect on the new grant.
  svc.submitDecisions([{ entryId: cycle2.entryIds[0], decision: 'confirm' }], T0 + 500);
  assert.equal(svc.getGrantStatus(newGrant, T0 + 500).status, 'active');
  assert.equal(svc.getGrantStatus(oldGrant, T0 + 500).status, 'revoked');

  // A further old cycle that also revokes still cannot touch the new instance.
  const cycle3 = svc.openReviewCycle('db1', T0 + 600);
  assert.equal(cycle3.entryIds.length, 1); // only the new, unrevoked grant is enrolled
  svc.submitDecisions([{ entryId: cycle3.entryIds[0], decision: 'revoke' }], T0 + 700);
  assert.equal(svc.getGrantStatus(newGrant, T0 + 700).status, 'revoked');
  assert.equal(svc.getGrantStatus(oldGrant, T0 + 700).status, 'revoked');
});

test('duplicate grant of the same combo is rejected while unrevoked (suspension is not a bypass)', () => {
  const svc = newService();
  svc.grantAccess({ user: 'carol', database: 'db1', role: 'admin' }, T0);
  const cycle = svc.openReviewCycle('db1', T0 + 10);
  const overdueAt = cycle.deadline + 1;
  assert.throws(
    () => svc.grantAccess({ user: 'carol', database: 'db1', role: 'admin' }, overdueAt),
    /unrevoked grant already exists/,
  );
});

test('cycle enrollment is a snapshot: later grants and re-grants are not backfilled', () => {
  const svc = newService();
  svc.grantAccess({ user: 'dave', database: 'db1', role: 'reader' }, T0);
  const cycle = svc.openReviewCycle('db1', T0 + 10);
  assert.equal(cycle.entryIds.length, 1);
  svc.grantAccess({ user: 'erin', database: 'db1', role: 'reader' }, T0 + 20);
  const cycle2 = svc.openReviewCycle('db1', T0 + 30);
  assert.equal(cycle2.entryIds.length, 2);
});

test('suspended instances are still enrolled in new cycles', () => {
  const svc = newService();
  const grantId = svc.grantAccess({ user: 'frank', database: 'db1', role: 'reader' }, T0);
  const cycle1 = svc.openReviewCycle('db1', T0 + 10);
  const overdueAt = cycle1.deadline + 1;
  assert.equal(svc.getGrantStatus(grantId, overdueAt).status, 'suspended');
  const cycle2 = svc.openReviewCycle('db1', overdueAt + 1);
  assert.equal(cycle2.entryIds.length, 1);
});

test('idempotent repeated decision succeeds; conflicting decision fails the whole batch atomically', () => {
  const svc = newService();
  const g1 = svc.grantAccess({ user: 'gus', database: 'db1', role: 'reader' }, T0);
  const g2 = svc.grantAccess({ user: 'hana', database: 'db1', role: 'reader' }, T0 + 1);
  const cycle = svc.openReviewCycle('db1', T0 + 10);
  const [e1, e2] = cycle.entryIds;

  svc.submitDecisions([{ entryId: e1, decision: 'confirm' }], T0 + 20);
  // Same decision again: success, no extra change.
  svc.submitDecisions([{ entryId: e1, decision: 'confirm' }], T0 + 21);

  // Batch across entries where one conflicts: entire batch rolls back.
  assert.throws(
    () =>
      svc.submitDecisions(
        [
          { entryId: e2, decision: 'revoke' },
          { entryId: e1, decision: 'revoke' },
        ],
        T0 + 22,
      ),
    /already finalized/,
  );
  // e2's revoke must have been rolled back too.
  assert.equal(svc.getGrantStatus(g2, T0 + 22).status, 'active');
  assert.equal(svc.getGrantStatus(g1, T0 + 22).status, 'active');

  // Conflicting duplicate inside a single batch also fails atomically.
  assert.throws(
    () =>
      svc.submitDecisions(
        [
          { entryId: e2, decision: 'confirm' },
          { entryId: e2, decision: 'revoke' },
        ],
        T0 + 23,
      ),
    /already finalized/,
  );
  assert.equal(svc.getGrantStatus(g2, T0 + 23).status, 'active');
});

test('a batch can span multiple cycles', () => {
  const svc = newService();
  const grantId = svc.grantAccess({ user: 'ivan', database: 'db1', role: 'reader' }, T0);
  const cycle1 = svc.openReviewCycle('db1', T0 + 10);
  const cycle2 = svc.openReviewCycle('db1', T0 + 20);
  svc.submitDecisions(
    [
      { entryId: cycle1.entryIds[0], decision: 'confirm' },
      { entryId: cycle2.entryIds[0], decision: 'confirm' },
    ],
    cycle2.deadline + 1,
  );
  assert.equal(svc.getGrantStatus(grantId, cycle2.deadline + 1).status, 'active');
});

test('decisions on overdue entries are still accepted', () => {
  const svc = newService();
  const grantId = svc.grantAccess({ user: 'judy', database: 'db1', role: 'reader' }, T0);
  const cycle = svc.openReviewCycle('db1', T0 + 10);
  const overdueAt = cycle.deadline + 5;
  assert.equal(svc.getGrantStatus(grantId, overdueAt).status, 'suspended');
  svc.submitDecisions([{ entryId: cycle.entryIds[0], decision: 'confirm' }], overdueAt + 1);
  assert.equal(svc.getGrantStatus(grantId, overdueAt + 1).status, 'active');
});

test('caller time must not go backwards', () => {
  const svc = newService();
  svc.grantAccess({ user: 'kate', database: 'db1', role: 'reader' }, T0);
  assert.throws(() => svc.openReviewCycle('db1', T0 - 1), /must not go backwards/);
});

test('unknown grant and unknown entry raise errors', () => {
  const svc = newService();
  assert.throws(() => svc.getGrantStatus(999, T0), /grant not found/);
  assert.throws(
    () => svc.submitDecisions([{ entryId: 999, decision: 'confirm' }], T0),
    /review entry not found/,
  );
});

test('state persists across service instances on the same SQLite file', () => {
  const path = `/tmp/review-test-${process.pid}.db`;
  const svc1 = createService(path);
  const grantId = svc1.grantAccess({ user: 'leo', database: 'db1', role: 'reader' }, T0);
  const cycle = svc1.openReviewCycle('db1', T0 + 10);

  const svc2 = createService(path);
  assert.equal(svc2.getGrantStatus(grantId, cycle.deadline).status, 'suspended');
  svc2.submitDecisions([{ entryId: cycle.entryIds[0], decision: 'confirm' }], cycle.deadline + 1);
  assert.equal(svc2.getGrantStatus(grantId, cycle.deadline + 1).status, 'active');
});
