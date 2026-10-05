import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ManualClock,
  MarketingAutomation,
  type ChainRecord,
  type SendOutcome,
  type SendRequest,
  type Sender,
  type SubscriberRecord,
} from '../src/index.js';

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

class ManualSender {
  readonly calls: SendRequest[] = [];
  private readonly pending = new Map<string, (outcome: SendOutcome) => void>();

  readonly send: Sender = (req) => {
    this.calls.push(req);
    return new Promise<SendOutcome>((resolve) => {
      this.pending.set(req.attemptId, resolve);
    });
  };

  resolve(attemptId: string, outcome: SendOutcome): void {
    const settle = this.pending.get(attemptId);
    assert.ok(settle, `no pending attempt ${attemptId}`);
    this.pending.delete(attemptId);
    settle(outcome);
  }
}

function allAttempts(sub: SubscriberRecord) {
  return sub.chains.flatMap((chain) => chain.steps.flatMap((step) => step.attempts));
}

function assertCallsMatchRecords(sub: SubscriberRecord, calls: SendRequest[]): void {
  const attempts = allAttempts(sub);
  const started = attempts.filter((attempt) => attempt.startedAt !== null);
  assert.equal(started.length, calls.length, 'started attempts must equal simulator calls');
  assert.deepEqual(
    new Set(started.map((attempt) => attempt.attemptId)),
    new Set(calls.map((call) => call.attemptId)),
    'simulator call attemptIds must match queryable records',
  );
  assert.equal(
    new Set(attempts.map((attempt) => attempt.attemptId)).size,
    attempts.length,
    'attempt ids must be unique',
  );
}

test('concurrent replay of one trigger and concurrent queue advances start each attempt once', async () => {
  const clock = new ManualClock(0);
  const calls: SendRequest[] = [];
  const sender: Sender = async (req) => {
    calls.push(req);
    return 'success';
  };
  const engine = new MarketingAutomation({ sender, clock });

  await engine.submitEvent({ subscriberId: 'A', eventId: 'c1', kind: 'consent' });
  const plan = [
    { content: 'm0', delayMs: 0 },
    { content: 'm1', delayMs: 1000 },
  ];
  await Promise.all(
    Array.from({ length: 50 }, () =>
      engine.submitEvent({ subscriberId: 'A', eventId: 't1', kind: 'trigger', plan }),
    ),
  );

  let sub = engine.getSubscriber('A');
  assert.ok(sub);
  assert.equal(sub.chains.length, 1, 'replayed trigger must create exactly one chain');

  await Promise.all(Array.from({ length: 50 }, () => engine.advanceQueue()));
  assert.equal(calls.length, 1, 'concurrent advances must not duplicate the first attempt');
  await tick();

  clock.advance(1000);
  await Promise.all(Array.from({ length: 50 }, () => engine.advanceQueue()));
  assert.equal(calls.length, 2, 'concurrent advances must not duplicate the second step');
  await tick();

  sub = engine.getSubscriber('A');
  assert.ok(sub);
  assert.equal(sub.chains[0]?.status, 'completed');
  assertCallsMatchRecords(sub, calls);
});

test('timeout retries interleaved with late failure and late success', async () => {
  const clock = new ManualClock(0);
  const sender = new ManualSender();
  const engine = new MarketingAutomation({ sender: sender.send, clock });

  await engine.submitEvent({ subscriberId: 'B', eventId: 'c1', kind: 'consent' });
  await engine.submitEvent({
    subscriberId: 'B',
    eventId: 't1',
    kind: 'trigger',
    plan: [
      { content: 'm0', delayMs: 0 },
      { content: 'm1', delayMs: 100 },
    ],
  });

  await engine.advanceQueue();
  assert.equal(sender.calls.length, 1);
  const att1 = sender.calls[0]?.attemptId as string;

  // att1 times out at 45_000; retry 1 becomes due at 105_000.
  clock.set(45_000);
  await engine.advanceQueue();
  assert.equal(sender.calls.length, 1, 'retry 1 not yet due');

  clock.set(105_000);
  await engine.advanceQueue();
  assert.equal(sender.calls.length, 2);
  const att2 = sender.calls[1]?.attemptId as string;

  // att2 times out at 150_000; retry 2 becomes due at 450_000.
  clock.set(150_000);
  await engine.advanceQueue();
  assert.equal(sender.calls.length, 2, 'retry 2 not yet due');

  // Late failure of att2: timeout already consumed the retry, no extra retry.
  clock.set(160_000);
  sender.resolve(att2, 'failure');
  await tick();
  let chain = engine.getSubscriber('B')?.chains[0] as ChainRecord;
  assert.equal(chain.steps[0]?.attempts.length, 3, 'late failure must not add another retry');
  assert.equal(chain.steps[0]?.attempts[2]?.status, 'scheduled');
  assert.equal(chain.steps[0]?.attempts[2]?.dueAt, 450_000);

  // Late success of att1: step 0 succeeds, pending retry 2 is cancelled, step 1 appears once.
  clock.set(200_000);
  sender.resolve(att1, 'success');
  await tick();
  chain = engine.getSubscriber('B')?.chains[0] as ChainRecord;
  const step0 = chain.steps[0];
  assert.equal(step0?.status, 'succeeded');
  assert.equal(step0?.succeededAt, 200_000);
  assert.equal(step0?.attempts[0]?.status, 'timed_out');
  assert.equal(step0?.attempts[0]?.outcome, 'success');
  assert.equal(step0?.attempts[0]?.late, true);
  assert.equal(step0?.attempts[1]?.status, 'timed_out');
  assert.equal(step0?.attempts[1]?.outcome, 'failure');
  assert.equal(step0?.attempts[2]?.status, 'cancelled');
  assert.equal(chain.steps.length, 2, 'late success must not duplicate later steps');
  assert.equal(chain.steps[1]?.status, 'in_progress');
  assert.equal(chain.steps[1]?.dueAt, 200_100);

  // Cancelled retry 2 never starts even long after its due time.
  clock.set(200_100);
  await engine.advanceQueue();
  assert.equal(sender.calls.length, 3, 'only step 1 may start');
  const att4 = sender.calls[2]?.attemptId as string;

  // Returning exactly 45s after start counts as late, but the success still lands.
  clock.set(200_100 + 45_000);
  sender.resolve(att4, 'success');
  await tick();
  chain = engine.getSubscriber('B')?.chains[0] as ChainRecord;
  assert.equal(chain.status, 'completed');
  const step1 = chain.steps[1];
  assert.equal(step1?.status, 'succeeded');
  assert.equal(step1?.attempts.length, 2, 'late success spawns one retry slot then cancels it');
  assert.equal(step1?.attempts[0]?.status, 'timed_out');
  assert.equal(step1?.attempts[0]?.late, true);
  assert.equal(step1?.attempts[1]?.status, 'cancelled');

  clock.set(10_000_000);
  await engine.advanceQueue();
  assert.equal(sender.calls.length, 3, 'no further sends after completion');

  const sub = engine.getSubscriber('B');
  assert.ok(sub);
  assertCallsMatchRecords(sub, sender.calls);
});

test('receipts after STOP and re-consent never revive old chains; replays keep new period', async () => {
  const clock = new ManualClock(0);
  const sender = new ManualSender();
  const engine = new MarketingAutomation({ sender: sender.send, clock });

  await engine.submitEvent({ subscriberId: 'C', eventId: 'c1', kind: 'consent' });
  clock.set(10);
  await engine.submitEvent({
    subscriberId: 'C',
    eventId: 't1',
    kind: 'trigger',
    plan: [
      { content: 'm0', delayMs: 0 },
      { content: 'm1', delayMs: 50 },
    ],
  });
  await engine.advanceQueue();
  assert.equal(sender.calls.length, 1);
  const oldAttempt = sender.calls[0]?.attemptId as string;
  const oldChainId = sender.calls[0]?.chainId as string;

  clock.set(20);
  await engine.submitEvent({ subscriberId: 'C', eventId: 's1', kind: 'stop' });

  // Trigger while unsubscribed is remembered but creates no chain.
  clock.set(25);
  await engine.submitEvent({
    subscriberId: 'C',
    eventId: 't2',
    kind: 'trigger',
    plan: [{ content: 'x0', delayMs: 0 }],
  });

  clock.set(30);
  await engine.submitEvent({ subscriberId: 'C', eventId: 'c2', kind: 'consent' });
  clock.set(40);
  await engine.submitEvent({
    subscriberId: 'C',
    eventId: 't3',
    kind: 'trigger',
    plan: [{ content: 'n0', delayMs: 0 }],
  });

  // Old attempt returns after STOP: recorded, but no retry and no next step.
  clock.set(50);
  sender.resolve(oldAttempt, 'success');
  await tick();
  let oldChain = engine.getChain(oldChainId);
  assert.equal(oldChain?.status, 'cancelled');
  assert.equal(oldChain?.steps[0]?.status, 'cancelled');
  assert.equal(oldChain?.steps[0]?.attempts.length, 1);
  assert.equal(oldChain?.steps[0]?.attempts[0]?.status, 'succeeded');
  assert.equal(oldChain?.steps[1]?.attempts.length, 0);

  // Replays of old events (including STOP) must not disturb the new consent period.
  clock.set(60);
  await engine.submitEvent({ subscriberId: 'C', eventId: 'c1', kind: 'consent' });
  await engine.submitEvent({
    subscriberId: 'C',
    eventId: 't1',
    kind: 'trigger',
    plan: [
      { content: 'm0', delayMs: 0 },
      { content: 'm1', delayMs: 50 },
    ],
  });
  await engine.submitEvent({ subscriberId: 'C', eventId: 's1', kind: 'stop' });
  await engine.submitEvent({
    subscriberId: 'C',
    eventId: 't2',
    kind: 'trigger',
    plan: [{ content: 'x0', delayMs: 0 }],
  });
  // A fresh consent while consented does not roll the period either.
  clock.set(65);
  await engine.submitEvent({ subscriberId: 'C', eventId: 'c3', kind: 'consent' });

  let sub = engine.getSubscriber('C');
  assert.ok(sub);
  assert.equal(sub.consented, true);
  assert.equal(sub.currentConsentPeriodId, 2);
  assert.equal(sub.consentPeriods.length, 2);
  assert.equal(sub.consentPeriods[0]?.endedAt, 20);
  assert.equal(sub.consentPeriods[0]?.endReason, 'stop');
  assert.equal(sub.consentPeriods[1]?.startedAt, 30);
  assert.equal(sub.consentPeriods[1]?.endedAt, null);
  assert.equal(sub.chains.length, 2, 't1 created the old chain, t3 the new one, t2 none');

  // New chain runs normally; old chain never sends again.
  await engine.advanceQueue();
  assert.equal(sender.calls.length, 2);
  const newCall = sender.calls[1];
  assert.ok(newCall);
  assert.notEqual(newCall.chainId, oldChainId);
  sender.resolve(newCall.attemptId, 'success');
  await tick();

  sub = engine.getSubscriber('C');
  assert.ok(sub);
  const newChain = sub.chains.find((chain) => chain.chainId !== oldChainId);
  assert.equal(newChain?.status, 'completed');
  assert.equal(newChain?.consentPeriodId, 2);

  oldChain = engine.getChain(oldChainId);
  assert.equal(oldChain?.consentPeriodId, 1);
  assert.equal(oldChain?.status, 'cancelled');
  assertCallsMatchRecords(sub, sender.calls);
});

test('a never-returning simulator never blocks unsubscribes, other subscribers, or advances', async () => {
  const clock = new ManualClock(0);
  const calls: SendRequest[] = [];
  const sender: Sender = (req) => {
    calls.push(req);
    if (req.subscriberId === 'D') return new Promise<SendOutcome>(() => {});
    return Promise.resolve('success');
  };
  const engine = new MarketingAutomation({ sender, clock });

  await engine.submitEvent({ subscriberId: 'D', eventId: 'c1', kind: 'consent' });
  await engine.submitEvent({
    subscriberId: 'D',
    eventId: 't1',
    kind: 'trigger',
    plan: [{ content: 'm0', delayMs: 0 }],
  });
  await engine.advanceQueue();
  assert.equal(calls.length, 1);

  const startedAt = Date.now();
  await engine.submitEvent({ subscriberId: 'D', eventId: 's1', kind: 'stop' });
  await engine.submitEvent({ subscriberId: 'D', eventId: 'c2', kind: 'consent' });
  await engine.submitEvent({ subscriberId: 'E', eventId: 'c1', kind: 'consent' });
  await engine.submitEvent({
    subscriberId: 'E',
    eventId: 't1',
    kind: 'trigger',
    plan: [{ content: 'e0', delayMs: 0 }],
  });
  clock.set(45_000);
  await engine.advanceQueue();
  await tick();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `work must finish within 1s, took ${elapsed}ms`);

  const subE = engine.getSubscriber('E');
  assert.equal(subE?.chains[0]?.status, 'completed');
  const subD = engine.getSubscriber('D');
  assert.equal(subD?.chains[0]?.status, 'cancelled');
  assert.equal(subD?.chains[0]?.steps[0]?.attempts[0]?.status, 'timed_out');
  assert.equal(subD?.consented, true);
  assert.equal(calls.filter((call) => call.subscriberId === 'D').length, 1);
  assertCallsMatchRecords(subE as SubscriberRecord, calls.filter((call) => call.subscriberId === 'E'));
});

test('chain terminates after the initial attempt plus 3 retries fail', async () => {
  const clock = new ManualClock(0);
  const calls: SendRequest[] = [];
  const sender: Sender = async (req) => {
    calls.push(req);
    return 'failure';
  };
  const engine = new MarketingAutomation({ sender, clock });

  await engine.submitEvent({ subscriberId: 'F', eventId: 'c1', kind: 'consent' });
  await engine.submitEvent({
    subscriberId: 'F',
    eventId: 't1',
    kind: 'trigger',
    plan: [{ content: 'm0', delayMs: 0 }],
  });

  await engine.advanceQueue();
  await tick();
  const dueTimes = [60_000, 300_000, 1_800_000];
  for (const [index, delay] of dueTimes.entries()) {
    assert.equal(calls.length, index + 1);
    clock.advance(delay);
    await engine.advanceQueue();
    await tick();
  }
  assert.equal(calls.length, 4, 'initial attempt plus 3 retries');

  const sub = engine.getSubscriber('F');
  assert.ok(sub);
  const chain = sub.chains[0];
  assert.equal(chain?.status, 'failed');
  assert.equal(chain?.steps[0]?.status, 'failed');
  assert.equal(chain?.steps[0]?.attempts.length, 4);
  assert.deepEqual(
    chain?.steps[0]?.attempts.map((attempt) => attempt.status),
    ['failed', 'failed', 'failed', 'failed'],
  );

  clock.advance(10_000_000);
  await engine.advanceQueue();
  assert.equal(calls.length, 4, 'terminated chain never sends again');
  assertCallsMatchRecords(sub, calls);
});

test('supports 10_000 open chains and 50-way concurrent submissions and advances', async () => {
  const clock = new ManualClock(0);
  const calls: SendRequest[] = [];
  const sender: Sender = async (req) => {
    calls.push(req);
    return 'success';
  };
  const engine = new MarketingAutomation({ sender, clock });

  const submissions: Promise<void>[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    const subscriberId = `sub-${i}`;
    submissions.push(engine.submitEvent({ subscriberId, eventId: `c-${i}`, kind: 'consent' }));
    submissions.push(
      engine.submitEvent({
        subscriberId,
        eventId: `t-${i}`,
        kind: 'trigger',
        plan: [{ content: `m-${i}`, delayMs: 0 }],
      }),
    );
    // Keep roughly 50 submissions in flight at a time.
    if (submissions.length >= 50) {
      await Promise.all(submissions.splice(0, submissions.length));
    }
  }
  await Promise.all(submissions);

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: 50 }, () => engine.advanceQueue()));
  const elapsed = Date.now() - startedAt;
  assert.equal(calls.length, 10_000, 'every open chain starts exactly one attempt');
  assert.ok(elapsed < 1000, `concurrent advances must finish within 1s, took ${elapsed}ms`);

  await tick();
  const sample = engine.getSubscriber('sub-4242');
  assert.equal(sample?.chains[0]?.status, 'completed');
  assertCallsMatchRecords(
    sample as SubscriberRecord,
    calls.filter((call) => call.subscriberId === 'sub-4242'),
  );
});
