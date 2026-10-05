import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogicalClock, MarketingAutomation } from '../src/index.ts';
import { ControlledSimulator, flush } from './helpers.ts';

const plan = [
  { content: 'm1', delayMs: 0 },
  { content: 'm2', delayMs: 10_000 },
];

test('STOP cancels due and scheduled sends of the current epoch permanently', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });
  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });

  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 0);
  assert.equal(sim.calls.length, 0);

  const chain = engine.getChains('u1')[0];
  assert.equal(chain.status, 'terminated');
  assert.equal(chain.endReason, 'stopped');
  assert.equal(chain.steps[0].status, 'cancelled');

  clock.advance(1_000_000);
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 0);
});

test('receipt after STOP is recorded but produces no retry or next step', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 1);

  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });

  clock.advance(1_000);
  sim.settle(0, 'success');
  await flush();

  const chain = engine.getChains('u1')[0];
  assert.equal(chain.status, 'terminated');
  assert.equal(chain.steps[0].status, 'cancelled');
  assert.equal(chain.steps[1].status, 'cancelled');

  const attempts = engine.getAttempts(chain.chainId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'success');
  assert.equal(attempts[0].outcomeAt, 1_000);
  assert.equal(attempts[0].epoch, 1);

  clock.advance(1_000_000);
  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 0);
  assert.equal(sim.calls.length, 1);
});

test('old chain never resumes after re-consent and new chain runs in the new epoch', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 1);

  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });
  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c2' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't2', plan });

  // replaying old events must not disturb the new consent period
  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });
  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });

  const chains = engine.getChains('u1');
  assert.equal(chains.length, 2);
  const [oldChain, newChain] = chains;
  assert.equal(oldChain.epoch, 1);
  assert.equal(oldChain.status, 'terminated');
  assert.equal(newChain.epoch, 2);
  assert.equal(newChain.status, 'active');

  // late success from the old chain must not revive it
  sim.settle(0, 'success');
  await flush();
  assert.equal(engine.getChains('u1')[0].status, 'terminated');

  // the new chain starts and completes normally
  const r1 = await engine.advanceQueue();
  assert.equal(r1.startedAttempts, 1);
  assert.equal(sim.calls.length, 2);
  assert.equal(sim.calls[1].req.epoch, 2);
  sim.settle(1, 'success');
  await flush();

  clock.advance(10_000);
  const r2 = await engine.advanceQueue();
  assert.equal(r2.startedAttempts, 1);
  assert.equal(sim.calls.length, 2 + 1);
  sim.settle(2, 'success');
  await flush();

  const finalChains = engine.getChains('u1');
  assert.equal(finalChains[1].status, 'completed');
  assert.equal(finalChains[0].status, 'terminated');

  // every simulator call is backed by exactly one attempt record
  const records = finalChains.flatMap((c) => engine.getAttempts(c.chainId));
  assert.equal(sim.calls.length, records.length);
  assert.deepEqual(
    sim.calls.map((c) => c.req.attemptId).sort(),
    records.map((r) => r.attemptId).sort(),
  );
});

test('STOP replay after re-consent does not cancel the new epoch', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });
  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c2' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });
  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });

  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 1);
  assert.equal(sim.calls.length, 1);
  assert.equal(engine.getChains('u1')[0].epoch, 2);
});

test('failure after STOP is recorded without consuming a retry slot', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({
    kind: 'trigger',
    subscriberId: 'u1',
    eventId: 't1',
    plan: [{ content: 'm1', delayMs: 0 }],
  });
  await engine.advanceQueue();
  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });

  sim.settle(0, 'failure');
  await flush();

  const chain = engine.getChains('u1')[0];
  const attempts = engine.getAttempts(chain.chainId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'failure');

  clock.advance(1_000_000);
  const result = await engine.advanceQueue();
  assert.equal(result.startedAttempts, 0);
  assert.equal(sim.calls.length, 1);
});
