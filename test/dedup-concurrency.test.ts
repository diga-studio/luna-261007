import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogicalClock, MarketingAutomation } from '../src/index.ts';
import type { SendRequest } from '../src/index.ts';
import { ControlledSimulator, flush } from './helpers.ts';

const plan = [
  { content: 'm1', delayMs: 1_000 },
  { content: 'm2', delayMs: 2_000 },
];

function totalAttempts(engine: MarketingAutomation): number {
  return engine
    .getChains()
    .reduce((sum, chain) => sum + engine.getAttempts(chain.chainId).length, 0);
}

test('concurrent replay of the same trigger creates exactly one chain and one send', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });

  const trigger = { kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan } as const;
  await Promise.all(Array.from({ length: 50 }, () => engine.submitEvent({ ...trigger })));

  assert.equal(engine.getChains('u1').length, 1);

  clock.advance(1_000);
  const advances = await Promise.all(Array.from({ length: 50 }, () => engine.advanceQueue()));
  const started = advances.reduce((sum, r) => sum + r.startedAttempts, 0);
  assert.equal(started, 1);
  assert.equal(sim.calls.length, 1);
  assert.equal(totalAttempts(engine), 1);

  // replaying the trigger again later still has no effect
  clock.advance(60_000);
  await engine.submitEvent({ ...trigger });
  assert.equal(engine.getChains('u1').length, 1);
});

test('concurrent queue advancement never starts the same attempt twice', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  for (let i = 0; i < 20; i += 1) {
    await engine.submitEvent({
      kind: 'trigger',
      subscriberId: 'u1',
      eventId: `t${i}`,
      plan: [{ content: `m${i}`, delayMs: 0 }],
    });
  }
  const results = await Promise.all(Array.from({ length: 50 }, () => engine.advanceQueue()));
  const started = results.reduce((sum, r) => sum + r.startedAttempts, 0);
  assert.equal(started, 20);
  assert.equal(sim.calls.length, 20);
  assert.equal(totalAttempts(engine), 20);
  const attemptIds = sim.calls.map((c: { req: SendRequest }) => c.req.attemptId);
  assert.equal(new Set(attemptIds).size, 20);
});

test('trigger received while unsubscribed is remembered and replay cannot backfill', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({
    kind: 'trigger',
    subscriberId: 'u1',
    eventId: 't1',
    plan,
  });
  assert.equal(engine.getChains('u1').length, 0);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });
  assert.equal(engine.getChains('u1').length, 0);

  clock.advance(60_000);
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 0);
});

test('replay across stop and re-consent never produces new effects', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });
  await engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' });
  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c2' });

  await Promise.all([
    engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' }),
    engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan }),
    engine.submitEvent({ kind: 'stop', subscriberId: 'u1', eventId: 's1' }),
  ]);

  const chains = engine.getChains('u1');
  assert.equal(chains.length, 1);
  assert.equal(chains[0].epoch, 1);
  assert.equal(chains[0].status, 'terminated');

  clock.advance(60_000);
  await engine.advanceQueue();
  assert.equal(sim.calls.length, 0);
});

test('duplicate consent while consented does not start a new epoch', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c1' });
  await engine.submitEvent({ kind: 'consent', subscriberId: 'u1', eventId: 'c2' });
  await engine.submitEvent({ kind: 'trigger', subscriberId: 'u1', eventId: 't1', plan });

  const chains = engine.getChains('u1');
  assert.equal(chains.length, 1);
  assert.equal(chains[0].epoch, 1);
});

test('many subscribers and concurrent submissions stay consistent', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  const submissions = [];
  for (let i = 0; i < 50; i += 1) {
    const subscriberId = `u${i}`;
    submissions.push(engine.submitEvent({ kind: 'consent', subscriberId, eventId: `c${i}` }));
    submissions.push(
      engine.submitEvent({
        kind: 'trigger',
        subscriberId,
        eventId: 'shared-trigger',
        plan: [{ content: 'm', delayMs: 0 }],
      }),
    );
    submissions.push(
      engine.submitEvent({
        kind: 'trigger',
        subscriberId,
        eventId: 'shared-trigger',
        plan: [{ content: 'm', delayMs: 0 }],
      }),
    );
  }
  await Promise.all(submissions);
  assert.equal(engine.getChains().length, 50);

  await Promise.all(Array.from({ length: 50 }, () => engine.advanceQueue()));
  assert.equal(sim.calls.length, 50);
  assert.equal(totalAttempts(engine), 50);
});
