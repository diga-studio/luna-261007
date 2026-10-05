import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTEMPT_TIMEOUT_MS,
  LogicalClock,
  MarketingAutomation,
  RETRY_DELAYS_MS,
} from '../src/index.ts';
import { ControlledSimulator, flush } from './helpers.ts';

const [RETRY_1, RETRY_2, RETRY_3] = RETRY_DELAYS_MS;

async function setup(plan = [{ content: 'm1', delayMs: 0 }, { content: 'm2', delayMs: 5_000 }]) {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);
  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });
  return { clock, sim, engine };
}

test('attempt times out at exactly start+45s and retry is due 1 minute later', async () => {
  const { clock, sim, engine } = await setup();
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 1);
  const startedAt = sim.calls[0].req.attemptId ? 0 : 0;

  clock.advance(ATTEMPT_TIMEOUT_MS - 1);
  let result = await engine.advanceQueue();
  assert.equal(result.timedOutAttempts, 0);
  assert.equal(result.startedAttempts, 0);

  clock.advance(1);
  result = await engine.advanceQueue();
  assert.equal(result.timedOutAttempts, 1);
  assert.equal(result.startedAttempts, 0);

  clock.advance(RETRY_1 - 1);
  result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 0);

  clock.advance(1);
  result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 1);
  assert.equal(sim.calls.length, 2);

  const attempts = engine.getAttempts(engine.getChains('u1')[0].chainId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].outcome, 'timeout');
  assert.equal(attempts[0].outcomeAt, startedAt + ATTEMPT_TIMEOUT_MS);
  assert.equal(attempts[1].startedAt, ATTEMPT_TIMEOUT_MS + RETRY_1);
  assert.equal(sim.calls.length, attempts.length);
});

test('result arriving at exactly 45s counts as late; late success completes step once', async () => {
  const { clock, sim, engine } = await setup();
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 1);

  clock.advance(ATTEMPT_TIMEOUT_MS);
  sim.settle(0, 'success');
  await flush();

  const chainId = engine.getChains('u1')[0].chainId;
  let attempts = engine.getAttempts(chainId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'timeout');
  assert.equal(attempts[0].lateResult, 'success');
  assert.equal(attempts[0].lateResultAt, ATTEMPT_TIMEOUT_MS);

  // step succeeded via the late success; the scheduled retry must be cancelled.
  // advancing past the cancelled retry time must not restart step 0; the only
  // send that may start is step 1 (due 5s after the success receipt).
  clock.advance(RETRY_1);
  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 1);
  assert.equal(sim.calls.length, 2);
  assert.equal(sim.calls[1].req.stepIndex, 1);
  assert.equal(sim.calls[1].req.attemptIndex, 0);

  attempts = engine.getAttempts(chainId);
  assert.equal(attempts.filter((a) => a.stepIndex === 0).length, 1);
});

test('late success after retry started produces the next step only once', async () => {
  const { clock, sim, engine } = await setup();
  await engine.advanceQueue();

  clock.advance(ATTEMPT_TIMEOUT_MS);
  await engine.advanceQueue();
  clock.advance(RETRY_1);
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 2);

  // attempt 1 (timed out) now reports success late
  sim.settle(0, 'success');
  await flush();
  const chainId = engine.getChains('u1')[0].chainId;
  let chain = engine.getChains('u1')[0];
  assert.equal(chain.steps[0].status, 'succeeded');

  // attempt 2 also reports success; it must not advance the chain again
  sim.settle(1, 'success');
  await flush();
  chain = engine.getChains('u1')[0];
  assert.equal(chain.steps[1].status, 'pending');

  clock.advance(5_000);
  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 1);
  assert.equal(sim.calls.length, 3);
  assert.equal(sim.calls[2].req.stepIndex, 1);

  const attempts = engine.getAttempts(chainId);
  assert.equal(attempts.filter((a) => a.stepIndex === 1).length, 1);
  assert.equal(sim.calls.length, attempts.length);
});

test('late failure after timeout cannot schedule another retry', async () => {
  const { clock, sim, engine } = await setup([{ content: 'm1', delayMs: 0 }]);
  await engine.advanceQueue();

  clock.advance(ATTEMPT_TIMEOUT_MS);
  await engine.advanceQueue();

  clock.advance(10_000);
  sim.settle(0, 'failure');
  await flush();

  const chainId = engine.getChains('u1')[0].chainId;
  const attempts = engine.getAttempts(chainId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'timeout');
  assert.equal(attempts[0].lateResult, 'failure');

  // retry still due at the original schedule (timeout + 1min), not failure + 1min
  clock.advance(RETRY_1 - 10_000);
  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 1);
  assert.equal(sim.calls.length, 2);
});

test('mixed failure and timeout exhaust retries and terminate the chain', async () => {
  const { clock, sim, engine } = await setup([{ content: 'm1', delayMs: 0 }, { content: 'm2', delayMs: 0 }]);
  await engine.advanceQueue();

  // attempt 0: in-time failure -> retry in 1min
  sim.settle(0, 'failure');
  await flush();
  clock.advance(RETRY_1);
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 2);

  // attempt 1: timeout -> retry 5min after the timeout moment
  clock.advance(ATTEMPT_TIMEOUT_MS);
  await engine.advanceQueue();
  clock.advance(RETRY_2);
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 3);

  // attempt 2: in-time failure -> retry in 30min
  sim.settle(2, 'failure');
  await flush();
  clock.advance(RETRY_3);
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 4);

  // attempt 3: failure -> retries exhausted, chain terminated
  sim.settle(3, 'failure');
  await flush();

  const chain = engine.getChains('u1')[0];
  assert.equal(chain.status, 'terminated');
  assert.equal(chain.endReason, 'retries_exhausted');
  assert.equal(chain.steps[0].status, 'failed');
  assert.equal(chain.steps[1].status, 'cancelled');

  const attempts = engine.getAttempts(chain.chainId);
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts.map((a) => a.attemptIndex), [0, 1, 2, 3]);

  clock.advance(10 * RETRY_3);
  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 0);
  assert.equal(sim.calls.length, 4);
});

test('a simulator that never responds does not block other work', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'stuck', eventId: 'c1' });
  await engine.submitEvent({
    kind: 'trigger',
    subscriberId: 'stuck',
    eventId: 't1',
    plan: [{ content: 'm', delayMs: 0 }],
  });
  await engine.submitEvent({ kind: 'consent', subscriberId: 'other', eventId: 'c2' });
  await engine.submitEvent({
    kind: 'trigger',
    subscriberId: 'other',
    eventId: 't2',
    plan: [{ content: 'm', delayMs: 0 }],
  });

  const started = Date.now();
  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 2);
  assert.ok(Date.now() - started < 1_000);

  // unsubscribe + re-consent of the stuck subscriber completes promptly
  await engine.submitEvent({ kind: 'stop', subscriberId: 'stuck', eventId: 's1' });
  await engine.submitEvent({ kind: 'consent', subscriberId: 'stuck', eventId: 'c3' });
  assert.ok(Date.now() - started < 1_000);

  // other subscriber's send resolves and completes its chain
  const otherCall = sim.calls.findIndex((c) => c.req.subscriberId === 'other');
  sim.settle(otherCall, 'success');
  await flush();
  const otherChain = engine.getChains('other')[0];
  assert.equal(otherChain.status, 'completed');

  // the stuck attempt still records its fixed timeout, but its chain is
  // already terminated by STOP so no retry is scheduled
  clock.advance(ATTEMPT_TIMEOUT_MS);
  const afterTimeout = await engine.advanceQueue();
  assert.equal(afterTimeout.startedAttempts, 0);
  const stuckAttempts = engine.getAttempts(engine.getChains('stuck')[0].chainId);
  assert.equal(stuckAttempts.length, 1);
  assert.equal(stuckAttempts[0].outcome, 'timeout');
  assert.equal(sim.calls.length, 2);
});
